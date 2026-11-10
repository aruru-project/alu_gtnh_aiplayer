package alu.aiplayer.act;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;

import alu.aiplayer.AiPlayerMod;

/**
 * Storage Drawers, used the way a player uses them: punch a drawer's front to take from it, right-click the front
 * with an item in hand to put it in. A drawer has no screen and holds far more than its hopper-facing slots show,
 * so the generic container handling neither reads nor empties it properly.
 * <p>
 * The mod is reached by reflection and is optional; without it nothing here ever matches. Taking calls the very
 * method the server runs when a client reports a punch on a drawer, so the mod's own checks (reach, which face,
 * locks, protection events) all apply.
 */
public final class Drawers {

    private Drawers() {}

    public static final class Slot {

        public final int index;
        /** One item of the kind stored; null when the drawer is empty and unassigned. */
        public final ItemStack prototype;
        public final int count;
        public final int room;

        Slot(int index, ItemStack prototype, int count, int room) {
            this.index = index;
            this.prototype = prototype;
            this.count = count;
            this.room = room;
        }
    }

    private static final String PKG = "com.jaquadro.minecraft.storagedrawers.";
    private static boolean looked;
    private static boolean usable;
    private static Class<?> tileClass;
    private static Method drawerCount, drawer, enabled, prototype, stored, remaining, canStore;
    private static Method direction, rotation, sealed, clicked, slotAt;

    private static synchronized boolean available() {
        if (looked) return usable;
        looked = true;
        try {
            Class<?> group = Class.forName(PKG + "api.storage.IDrawerGroup");
            Class<?> one = Class.forName(PKG + "api.storage.IDrawer");
            Class<?> handler = Class.forName(PKG + "block.IExtendedBlockClickHandler");
            Class<?> block = Class.forName(PKG + "block.BlockDrawers");
            tileClass = Class.forName(PKG + "block.tile.TileEntityDrawers");
            drawerCount = group.getMethod("getDrawerCount");
            drawer = group.getMethod("getDrawer", int.class);
            enabled = group.getMethod("isDrawerEnabled", int.class);
            prototype = one.getMethod("getStoredItemPrototype");
            stored = one.getMethod("getStoredItemCount");
            remaining = one.getMethod("getRemainingCapacity");
            canStore = one.getMethod("canItemBeStored", ItemStack.class);
            direction = tileClass.getMethod("getDirection");
            rotation = tileClass.getMethod("getRotation");
            sealed = tileClass.getMethod("isSealed");
            clicked = handler.getMethod(
                "onBlockClicked",
                EntityPlayer.class,
                int.class,
                float.class,
                float.class,
                float.class,
                boolean.class,
                boolean.class);
            slotAt = block.getMethod("getDrawerSlot", int.class, int.class, float.class, float.class, float.class);
            usable = true;
        } catch (ClassNotFoundException e) {
            usable = false; // the mod is not installed
        } catch (Throwable t) {
            usable = false;
            AiPlayerMod.LOG.warn("Storage Drawers is installed but not in a form this mod knows; drawers are "
                + "handled as plain containers", t);
        }
        return usable;
    }

    public static boolean is(TileEntity te) {
        return te != null && available() && tileClass.isInstance(te);
    }

    /** The block that ties a wall of drawers into one store. It holds nothing itself. */
    public static boolean isController(TileEntity te) {
        return te != null && te.getClass()
            .getName()
            .equals(PKG + "block.tile.TileEntityController");
    }

    /** Where the drawer blocks a controller manages are; empty when it cannot be told. */
    public static List<int[]> managed(TileEntity controller) {
        List<int[]> out = new ArrayList<>();
        try {
            java.lang.reflect.Field f = controller.getClass()
                .getDeclaredField("storage");
            f.setAccessible(true);
            for (Object coord : new ArrayList<Object>(((java.util.Map<?, ?>) f.get(controller)).keySet())) {
                Class<?> c = coord.getClass();
                int x = (Integer) c.getMethod("x")
                    .invoke(coord);
                int y = (Integer) c.getMethod("y")
                    .invoke(coord);
                int z = (Integer) c.getMethod("z")
                    .invoke(coord);
                TileEntity te = controller.getWorldObj()
                    .getTileEntity(x, y, z);
                if (is(te)) out.add(new int[] { x, y, z });
            }
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Cannot read a drawer controller", t);
        }
        java.util.Collections.sort(out, (a, b) -> a[1] != b[1] ? b[1] - a[1] : a[0] != b[0] ? a[0] - b[0] : a[2] - b[2]);
        return out;
    }

    /** The face the drawer fronts are on (0 down .. 5 east), or -1 if it cannot be told. */
    public static int front(TileEntity te) {
        try {
            return (Integer) direction.invoke(te);
        } catch (Throwable t) {
            return -1;
        }
    }

    /** Sealed drawers have been taped shut for moving and give nothing. */
    public static boolean isSealed(TileEntity te) {
        try {
            return (Boolean) sealed.invoke(te);
        } catch (Throwable t) {
            return false;
        }
    }

    /** The drawers of one block with what they really hold. */
    public static List<Slot> slots(TileEntity te) {
        List<Slot> out = new ArrayList<>();
        try {
            int n = (Integer) drawerCount.invoke(te);
            for (int i = 0; i < n; i++) {
                if (!(Boolean) enabled.invoke(te, i)) continue;
                Object d = drawer.invoke(te, i);
                if (d == null) continue;
                ItemStack proto = (ItemStack) prototype.invoke(d);
                int count = proto == null ? 0 : (Integer) stored.invoke(d);
                int room = proto == null ? Integer.MAX_VALUE : (Integer) remaining.invoke(d);
                out.add(new Slot(i, proto, count, room));
            }
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Cannot read a drawer", t);
        }
        return out;
    }

    /** Whether a drawer would take this item: it stores that kind already, or it is free to be assigned. */
    public static boolean accepts(TileEntity te, int index, ItemStack stack) {
        try {
            Object d = drawer.invoke(te, index);
            return d != null && (Boolean) canStore.invoke(d, stack);
        } catch (Throwable t) {
            return false;
        }
    }

    /** Whether the player's eyes are on the side of the block the fronts face. */
    public static boolean inFront(EntityPlayerMP p, int x, int y, int z, int side) {
        double ey = p.posY + Reach.EYE_HEIGHT;
        switch (side) {
            case 0:
                return ey < y;
            case 1:
                return ey > y + 1;
            case 2:
                return p.posZ < z;
            case 3:
                return p.posZ > z + 1;
            case 4:
                return p.posX < x;
            case 5:
                return p.posX > x + 1;
            default:
                return false;
        }
    }

    private static final float[] SPOTS = { 0.25F, 0.75F, 0.5F };

    /** A point on the front face, as offsets within the block, that belongs to the given drawer; null if none. */
    public static float[] hit(TileEntity te, int index) {
        int side = front(te);
        if (side < 0) return null;
        Block block = te.getBlockType();
        try {
            int rot = (Integer) rotation.invoke(te);
            for (float u : SPOTS) {
                for (float v : SPOTS) {
                    float[] h = onFace(side, u, v);
                    if ((Integer) slotAt.invoke(block, side, rot, h[0], h[1], h[2]) == index) return h;
                }
            }
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Cannot work out where on a drawer block its drawers are", t);
        }
        return null;
    }

    private static float[] onFace(int side, float u, float v) {
        switch (side) {
            case 0:
                return new float[] { u, 0.0F, v };
            case 1:
                return new float[] { u, 1.0F, v };
            case 2:
                return new float[] { u, v, 0.0F };
            case 3:
                return new float[] { u, v, 1.0F };
            case 4:
                return new float[] { 0.0F, v, u };
            default:
                return new float[] { 1.0F, v, u };
        }
    }

    /**
     * Punches a drawer: what the server does when a player left-clicks its front. A whole stack comes out, or a
     * single item, into the player's inventory (onto the ground if that is full).
     */
    public static void punch(TileEntity te, EntityPlayerMP p, float[] hit, boolean wholeStack) {
        try {
            // The client sends along whether its "invert shift" option is on; with it, a plain click takes a stack.
            clicked.invoke(te, p, front(te), hit[0], hit[1], hit[2], wholeStack, false);
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Punching a drawer failed", t);
        }
    }
}
