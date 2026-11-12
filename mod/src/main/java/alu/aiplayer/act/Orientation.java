package alu.aiplayer.act;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import net.minecraft.block.Block;
import net.minecraft.block.BlockAnvil;
import net.minecraft.block.BlockBeacon;
import net.minecraft.block.BlockBrewingStand;
import net.minecraft.block.BlockChest;
import net.minecraft.block.BlockCocoa;
import net.minecraft.block.BlockCommandBlock;
import net.minecraft.block.BlockDispenser;
import net.minecraft.block.BlockEnchantmentTable;
import net.minecraft.block.BlockEndPortalFrame;
import net.minecraft.block.BlockEnderChest;
import net.minecraft.block.BlockFenceGate;
import net.minecraft.block.BlockFurnace;
import net.minecraft.block.BlockHopper;
import net.minecraft.block.BlockLever;
import net.minecraft.block.BlockPistonBase;
import net.minecraft.block.BlockPumpkin;
import net.minecraft.block.BlockRedstoneDiode;
import net.minecraft.block.BlockSkull;
import net.minecraft.block.BlockStairs;
import net.minecraft.entity.EntityLivingBase;
import net.minecraft.item.Item;
import net.minecraft.item.ItemBlock;
import net.minecraft.item.ItemSlab;
import net.minecraft.item.ItemStack;
import net.minecraft.util.MathHelper;
import net.minecraft.world.World;

/**
 * Which way a block comes out when a player places it, and so where to stand and what to click to have it come out
 * a given way (its meta: a stair's facing, a slab's half, a log's axis).
 * <p>
 * In the game two pieces of the block's own code decide. First {@code onBlockPlaced} reads the face clicked and the
 * point on it (a log lies along the axis of the face clicked; a slab or stair clicked on the upper half of a side
 * goes upside down). The body calls that code as it is, for any block. Then {@code onBlockPlacedBy} reads the player:
 * which way it looks (a stair rises away from the player, a furnace faces it), for a piston also where it stands. That
 * part the body knows for the game's own block classes, and so for every block that inherits one of them (the stairs
 * of every mod); a block whose class brings placing code of its own is one the body cannot foresee, and says so.
 * <p>
 * The look a player has when it clicks is the direction from its eyes to the point clicked: where it stands decides
 * it. The body stands where that look gives the wanted meta, keeping clear of the edges between two directions, and
 * clicks only a face that turns towards its eyes, as a player can.
 */
public final class Orientation {

    private Orientation() {}

    /** What the player's look or stance does to the meta, by the class whose placing code the block runs. */
    public enum Rule {
        /** Nothing: the face and point clicked decide. */
        NONE,
        /** Rises away from the player; keeps the upside-down bit. */
        STAIRS,
        /** Faces the player (furnace, ender chest). */
        FRONT,
        /** Like FRONT, unless it joins a chest next to it. */
        CHEST,
        /** Faces the player, or up and down when the player stands close above or below (piston, dispenser). */
        PISTON,
        /** The player's facing turned round (pumpkin): its face looks at the player. */
        TURNED,
        /** The player's facing as it is (fence gate). */
        LOOK,
        /** The player's facing turned round, 0..3 (end portal frame, repeater). */
        LOOK_BACK,
        ANVIL,
        /** A lever on a floor or a ceiling lies along the player's look. */
        LEVER,
        /** The block's class has placing code of its own. */
        UNKNOWN
    }

    /** Degrees a look must keep from the edge between two facings, for a bot not standing exactly mid-cell. */
    public static final double YAW_MARGIN = 10.0;

    private static final String[] PLACED_BY = { "onBlockPlacedBy", "func_149689_a" };
    private static final Map<Class<?>, Class<?>> DECLARER = new HashMap<>();
    private static final Map<Class<?>, Rule> RULES = new HashMap<>();

    static {
        RULES.put(Block.class, Rule.NONE);
        RULES.put(BlockStairs.class, Rule.STAIRS);
        RULES.put(BlockFurnace.class, Rule.FRONT);
        RULES.put(BlockEnderChest.class, Rule.FRONT);
        RULES.put(BlockChest.class, Rule.CHEST);
        RULES.put(BlockPistonBase.class, Rule.PISTON);
        RULES.put(BlockDispenser.class, Rule.PISTON);
        RULES.put(BlockPumpkin.class, Rule.TURNED);
        RULES.put(BlockSkull.class, Rule.TURNED);
        RULES.put(BlockFenceGate.class, Rule.LOOK);
        RULES.put(BlockCocoa.class, Rule.LOOK);
        RULES.put(BlockEndPortalFrame.class, Rule.LOOK_BACK);
        RULES.put(BlockRedstoneDiode.class, Rule.LOOK_BACK);
        RULES.put(BlockAnvil.class, Rule.ANVIL);
        RULES.put(BlockLever.class, Rule.LEVER);
        // These only give the contents a custom name.
        RULES.put(BlockHopper.class, Rule.NONE);
        RULES.put(BlockBrewingStand.class, Rule.NONE);
        RULES.put(BlockBeacon.class, Rule.NONE);
        RULES.put(BlockCommandBlock.class, Rule.NONE);
        RULES.put(BlockEnchantmentTable.class, Rule.NONE);
    }

    /** The class whose {@code onBlockPlacedBy} the block runs. */
    public static synchronized Class<?> placedByClass(Block b) {
        Class<?> c = b.getClass();
        Class<?> known = DECLARER.get(c);
        if (known != null) return known;
        Class<?> found = Block.class;
        search: for (Class<?> k = c; k != null && k != Block.class && k != Object.class; k = k.getSuperclass()) {
            for (String name : PLACED_BY) {
                try {
                    Method m = k.getDeclaredMethod(name, World.class, int.class, int.class, int.class, EntityLivingBase.class, ItemStack.class);
                    if (m != null) {
                        found = k;
                        break search;
                    }
                } catch (NoSuchMethodException | SecurityException | NoClassDefFoundError e) {
                    // not declared here
                }
            }
        }
        DECLARER.put(c, found);
        return found;
    }

    public static Rule rule(Block b) {
        Rule r = RULES.get(placedByClass(b));
        return r == null ? Rule.UNKNOWN : r;
    }

    /** Vanilla's facing of a look: 0 south, 1 west, 2 north, 3 east. */
    public static int quadrant(float yaw) {
        return MathHelper.floor_double((double) (yaw * 4.0F / 360.0F) + 0.5D) & 3;
    }

    /** How far, in degrees, a yaw is from the edge between two facings. */
    public static double edgeDistance(float yaw) {
        // The facing changes where yaw / 90 + 0.5 is a whole number.
        double f = yaw / 90.0 + 0.5;
        return Math.abs(f - Math.rint(f)) * 90.0;
    }

    /** The yaw a player at (px, pz) has looking at (tx, tz), as the bot's head is turned to a point. */
    public static float yawTo(double px, double pz, double tx, double tz) {
        return (float) (Math.atan2(-(tx - px), tz - pz) * 180.0 / Math.PI);
    }

    private static final int[] STAIRS_BY_LOOK = { 2, 1, 3, 0 };
    private static final int[] FRONT_BY_LOOK = { 2, 5, 3, 4 };

    /**
     * The meta a block comes out with, from what {@code onBlockPlaced} gave and a player whose feet are at (px, py,
     * pz) and who looks with this yaw; -1 when the rule cannot tell.
     */
    public static int apply(Rule r, int m0, World w, Block b, int x, int y, int z, double px, double py, double pz,
        float yaw) {
        int q = quadrant(yaw);
        switch (r) {
            case NONE:
                return m0;
            case STAIRS:
                return STAIRS_BY_LOOK[q] | (m0 & 4);
            case FRONT:
                return FRONT_BY_LOOK[q];
            case CHEST:
                if (w == null) return FRONT_BY_LOOK[q];
                if (w.getBlock(x - 1, y, z) == b || w.getBlock(x + 1, y, z) == b
                    || w.getBlock(x, y, z - 1) == b
                    || w.getBlock(x, y, z + 1) == b) return -1;
                return FRONT_BY_LOOK[q];
            case PISTON:
                if (MathHelper.abs((float) px - (float) x) < 2.0F && MathHelper.abs((float) pz - (float) z) < 2.0F) {
                    // A player's yOffset on the server is 0: posY is the feet.
                    double d0 = py + 1.82D;
                    if (d0 - y > 2.0D) return 1;
                    if (y - d0 > 0.0D) return 0;
                }
                return FRONT_BY_LOOK[q];
            case TURNED:
                return (q + 2) & 3;
            case LOOK:
                return q;
            case LOOK_BACK:
                return (q + 2) % 4;
            case ANVIL: {
                int l = (q + 1) % 4;
                int keep = (m0 >> 2) << 2;
                return (l == 0 ? 2 : l == 1 ? 3 : l == 2 ? 0 : 1) | keep;
            }
            case LEVER: {
                int i1 = m0 & 7, j1 = m0 & 8;
                if (i1 == 5) return ((q & 1) == 0 ? 5 : 6) | j1;
                if (i1 == 0) return ((q & 1) == 0 ? 7 : 0) | j1;
                return m0;
            }
            default:
                return -1;
        }
    }

    /** Whether the rule reads the player's look at all. */
    public static boolean readsLook(Rule r, int m0) {
        if (r == Rule.NONE) return false;
        if (r == Rule.LEVER) return (m0 & 7) == 5 || (m0 & 7) == 0;
        return true;
    }

    // ---- ways to click --------------------------------------------------------------------------------------

    /** One click that places into the cell: a face of a neighbouring block, and the point on it. */
    public static final class Way {

        /** The block clicked, and its face that looks at the cell (0 down .. 5 east). */
        public final int sx, sy, sz, side;
        /** The point on it, each 0..1 from its lowest corner. */
        public final float hx, hy, hz;
        /** What onBlockPlaced gives for this click. */
        public final int m0;

        Way(int sx, int sy, int sz, int side, float hx, float hy, float hz, int m0) {
            this.sx = sx;
            this.sy = sy;
            this.sz = sz;
            this.side = side;
            this.hx = hx;
            this.hy = hy;
            this.hz = hz;
            this.m0 = m0;
        }

        public double px() {
            return sx + hx;
        }

        public double py() {
            return sy + hy;
        }

        public double pz() {
            return sz + hz;
        }

        /** Whether eyes at this point see the face clicked from its outer side. */
        public boolean faceTurnedTo(double ex, double ey, double ez) {
            final double e = 0.05;
            switch (side) {
                case 0:
                    return ey < sy - e;
                case 1:
                    return ey > sy + 1 + e;
                case 2:
                    return ez < sz - e;
                case 3:
                    return ez > sz + 1 + e;
                case 4:
                    return ex < sx - e;
                default:
                    return ex > sx + 1 + e;
            }
        }
    }

    // The neighbours of a cell, and the face of each that looks at the cell: as in Placer.
    private static final int[][] NEIGHBOURS = { { 0, -1, 0, 1 }, { 0, 0, -1, 3 }, { 0, 0, 1, 2 }, { -1, 0, 0, 5 },
        { 1, 0, 0, 4 }, { 0, 1, 0, 0 } };

    private static final String[] FACE_OF_CELL = { "below", "north", "south", "west", "east", "above" };

    /**
     * Every click that puts the block into the cell, with what {@code onBlockPlaced} gives for it: the middle of a
     * top or bottom face, the lower and upper half of a side face. Clicks whose result the block's code cannot give
     * (it threw) are left out. {@code w} may be null: then blocks that look at their neighbours cannot answer.
     */
    public static List<Way> ways(World w, int x, int y, int z, Block b, int placedMeta) {
        List<Way> out = new ArrayList<>();
        for (int[] n : NEIGHBOURS) {
            int sx = x + n[0], sy = y + n[1], sz = z + n[2], side = n[3];
            float[][] hits;
            switch (side) {
                case 0:
                    hits = new float[][] { { 0.5F, 0.0F, 0.5F } };
                    break;
                case 1:
                    hits = new float[][] { { 0.5F, 1.0F, 0.5F } };
                    break;
                case 2:
                    hits = new float[][] { { 0.5F, 0.25F, 0.0F }, { 0.5F, 0.75F, 0.0F } };
                    break;
                case 3:
                    hits = new float[][] { { 0.5F, 0.25F, 1.0F }, { 0.5F, 0.75F, 1.0F } };
                    break;
                case 4:
                    hits = new float[][] { { 0.0F, 0.25F, 0.5F }, { 0.0F, 0.75F, 0.5F } };
                    break;
                default:
                    hits = new float[][] { { 1.0F, 0.25F, 0.5F }, { 1.0F, 0.75F, 0.5F } };
                    break;
            }
            for (float[] h : hits) {
                int m0;
                try {
                    m0 = b.onBlockPlaced(w, x, y, z, side, h[0], h[1], h[2], placedMeta);
                } catch (Throwable t) {
                    continue;
                }
                out.add(new Way(sx, sy, sz, side, h[0], h[1], h[2], m0));
            }
        }
        return out;
    }

    /** Every meta a click this way can give, over all looks and stances the rule reads. */
    public static TreeSet<Integer> outcomes(Rule r, Way way) {
        TreeSet<Integer> out = new TreeSet<>();
        if (r == Rule.UNKNOWN) return out;
        if (!readsLook(r, way.m0)) {
            out.add(way.m0);
            return out;
        }
        for (int q = 0; q < 4; q++) {
            int m = apply(r, way.m0, null, null, 0, 0, 0, 1000, 0, 1000, q * 90.0F);
            if (m >= 0) out.add(m);
        }
        if (r == Rule.PISTON) {
            out.add(0);
            out.add(1);
        }
        return out;
    }

    /** Whether a click this way can give the meta at all, from some stance. */
    public static boolean canGive(Rule r, Way way, int want) {
        return outcomes(r, way).contains(want);
    }

    /**
     * Whether a player with feet at (px, py, pz), turning to the point of this way and clicking it, places the
     * block with meta {@code want}: the face turns towards its eyes, the point is within reach, and the look gives
     * that meta with room to spare.
     */
    public static boolean stanceGives(World w, Block b, Rule r, Way way, int x, int y, int z, double px, double py,
        double pz, int want, double reach) {
        double ex = px, ey = py + Reach.EYE_HEIGHT, ez = pz;
        if (!way.faceTurnedTo(ex, ey, ez)) return false;
        double dx = way.px() - ex, dy = way.py() - ey, dz = way.pz() - ez;
        if (dx * dx + dy * dy + dz * dz > reach * reach) return false;
        if (!readsLook(r, way.m0)) return way.m0 == want;
        double flat = Math.sqrt(dx * dx + dz * dz);
        // Right above or below the point the look has no direction to speak of.
        if (flat < 0.3) return false;
        float yaw = yawTo(px, pz, way.px(), way.pz());
        if (edgeDistance(yaw) < YAW_MARGIN) return false;
        if (r == Rule.PISTON) {
            // Keep clear of the lines where it turns from sideways to up or down.
            float ax = MathHelper.abs((float) px - (float) x), az = MathHelper.abs((float) pz - (float) z);
            if (Math.abs(ax - 2.0F) < 0.2F || Math.abs(az - 2.0F) < 0.2F) return false;
            double d0 = py + 1.82D;
            if (Math.abs(d0 - y - 2.0) < 0.1 || Math.abs(y - d0) < 0.1) return false;
        }
        return apply(r, way.m0, w, b, x, y, z, px, py, pz, yaw) == want;
    }

    // ---- what to tell when it cannot be done ----------------------------------------------------------------

    /**
     * In words, what a click that gives the meta has to land on: "the top of the block below it; or the upper half
     * of the side of a block north, south, west or east of it".
     */
    public static String facesFor(Rule r, List<Way> all, int x, int y, int z, int want) {
        // Per neighbour (index in NEIGHBOURS): bit 1 the lower half (or the whole face), bit 2 the upper half.
        int[] halves = new int[NEIGHBOURS.length];
        for (Way way : all) {
            if (!canGive(r, way, want)) continue;
            halves[faceIndex(way, x, y, z)] |= way.side >= 2 && way.hy > 0.5F ? 2 : 1;
        }
        List<String> parts = new ArrayList<>();
        if (halves[0] != 0) parts.add("the top of the block below it");
        String[] kinds = { "the side", "the lower half of the side", "the upper half of the side" };
        int[] masks = { 3, 1, 2 };
        for (int k = 0; k < kinds.length; k++) {
            List<String> dirs = new ArrayList<>();
            for (int i = 1; i <= 4; i++) if (halves[i] == masks[k]) dirs.add(FACE_OF_CELL[i]);
            if (!dirs.isEmpty()) parts.add(kinds[k] + " of a block " + orList(dirs) + " of it");
        }
        if (halves[5] != 0) parts.add("the underside of the block above it");
        return String.join("; or ", parts);
    }

    private static String orList(List<String> words) {
        if (words.size() == 1) return words.get(0);
        return String.join(", ", words.subList(0, words.size() - 1)) + " or " + words.get(words.size() - 1);
    }

    private static int faceIndex(Way way, int x, int y, int z) {
        for (int i = 0; i < NEIGHBOURS.length; i++) {
            if (x + NEIGHBOURS[i][0] == way.sx && y + NEIGHBOURS[i][1] == way.sy && z + NEIGHBOURS[i][2] == way.sz) return i;
        }
        return 0;
    }

    /** Every meta the block can come out with in this cell, over all clicks. */
    public static TreeSet<Integer> allOutcomes(Rule r, List<Way> all) {
        TreeSet<Integer> out = new TreeSet<>();
        for (Way way : all) out.addAll(outcomes(r, way));
        return out;
    }

    /** "/2, /6" */
    public static String metas(java.util.Collection<Integer> ms) {
        StringBuilder sb = new StringBuilder();
        for (Integer m : ms) {
            if (sb.length() > 0) sb.append(", ");
            sb.append('/').append(m);
        }
        return sb.length() == 0 ? "nothing it can foresee" : sb.toString();
    }

    // ---- which item, and whether it can be done at all ------------------------------------------------------

    /** The block an item places, or null when it is not a plain block item. */
    public static Block blockOf(Item item) {
        if (!(item instanceof ItemBlock)) return null;
        Block b = Block.getBlockFromItem(item);
        return b == null || b.getMaterial() == net.minecraft.block.material.Material.air ? null : b;
    }

    /** The meta the block is set to before its placing code runs, for an item of this damage. */
    public static int placedMeta(Item item, int damage) {
        return ((ItemBlock) item).getMetadata(damage);
    }

    /** Whether clicking a slab of the same kind on its top or bottom would join the two into a double slab. */
    public static boolean joinsSlab(Item item, Block support) {
        return item instanceof ItemSlab && Block.getBlockFromItem(item) == support;
    }

    /**
     * The item damage to place {@code want} with, when the caller did not say: the variant whose clicks can give
     * that meta in this cell (what the block drops first, then the meta itself, then the rest). -1 when none can,
     * or when the block's placing code is one the body cannot foresee.
     */
    public static int damageFor(World w, int x, int y, int z, Item item, int want) {
        Block b = blockOf(item);
        if (b == null) return -1;
        Rule r = rule(b);
        if (r == Rule.UNKNOWN) return -1;
        List<Integer> order = new ArrayList<>();
        try {
            order.add(b.damageDropped(want));
        } catch (Throwable t) {
            // a block that cannot say
        }
        order.add(want);
        for (int d = 0; d < 16; d++) if (!order.contains(d)) order.add(d);
        for (int d : order) {
            if (d < 0 || (d > 0 && !item.getHasSubtypes())) continue;
            int pm;
            try {
                pm = placedMeta(item, d);
            } catch (Throwable t) {
                continue;
            }
            if (allOutcomes(r, ways(w, x, y, z, b, pm)).contains(want)) return d;
        }
        return -1;
    }
}
