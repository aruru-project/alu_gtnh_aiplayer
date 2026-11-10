package alu.aiplayer.act;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.StatCollector;

import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.craft.RecipeBook;
import alu.aiplayer.util.J;

/**
 * GregTech machines as a player sees them from outside: what kind each is, what recipes it runs, whether it has
 * power and whether it is busy. Read by reflection; without GregTech nothing here matches.
 */
public final class Machines {

    private Machines() {}

    private static boolean looked;
    private static boolean usable;
    private static Class<?> baseClass, basicClass;
    private static Method metaOf, localName, progress, maxProgress, active, allowed, storedEu, inputVoltage, recipeMap;
    private static Method inputSlot, outputSlot;
    private static Field tier, inputCount, outputItems, mapName;

    private static synchronized boolean available() {
        if (looked) return usable;
        looked = true;
        try {
            baseClass = Class.forName("gregtech.api.interfaces.tileentity.IGregTechTileEntity");
            Class<?> meta = Class.forName("gregtech.api.interfaces.metatileentity.IMetaTileEntity");
            basicClass = Class.forName("gregtech.api.metatileentity.implementations.MTEBasicMachine");
            Class<?> tiered = Class.forName("gregtech.api.metatileentity.implementations.MTETieredMachineBlock");
            metaOf = baseClass.getMethod("getMetaTileEntity");
            localName = meta.getMethod("getLocalName");
            progress = baseClass.getMethod("getProgress");
            maxProgress = baseClass.getMethod("getMaxProgress");
            active = baseClass.getMethod("isActive");
            allowed = baseClass.getMethod("isAllowedToWork");
            storedEu = baseClass.getMethod("getStoredEU");
            inputVoltage = baseClass.getMethod("getInputVoltage");
            recipeMap = basicClass.getMethod("getRecipeMap");
            inputSlot = basicClass.getMethod("getInputSlot");
            outputSlot = basicClass.getMethod("getOutputSlot");
            tier = tiered.getField("mTier");
            inputCount = basicClass.getField("mInputSlotCount");
            outputItems = basicClass.getField("mOutputItems");
            mapName = Class.forName("gregtech.api.recipe.RecipeMap")
                .getField("unlocalizedName");
            usable = true;
        } catch (ClassNotFoundException e) {
            usable = false;
        } catch (Throwable t) {
            usable = false;
            AiPlayerMod.LOG.warn("GregTech is installed but not in a form this mod knows; machines go unrecognised", t);
        }
        return usable;
    }

    private static Object meta(TileEntity te) {
        if (te == null || !available() || !baseClass.isInstance(te)) return null;
        try {
            return metaOf.invoke(te);
        } catch (Throwable t) {
            return null;
        }
    }

    /** Whether the block is a GregTech machine, pipe, cable or the like. */
    public static boolean isGregTech(TileEntity te) {
        return meta(te) != null;
    }

    /** Whether it is one of the single-block processing machines: a few input slots, a few output slots. */
    public static boolean isProcessor(TileEntity te) {
        Object m = meta(te);
        return m != null && basicClass.isInstance(m);
    }

    /** The name a player reads on the machine, or null if this is not a GregTech block. */
    public static String name(TileEntity te) {
        Object m = meta(te);
        if (m == null) return null;
        try {
            return (String) localName.invoke(m);
        } catch (Throwable t) {
            return null;
        }
    }

    /** For a processing machine, the inventory slots that take input: {first, count}; null otherwise. */
    public static int[] inputSlots(TileEntity te) {
        Object m = meta(te);
        if (m == null || !basicClass.isInstance(m)) return null;
        try {
            return new int[] { (Integer) inputSlot.invoke(m), inputCount.getInt(m) };
        } catch (Throwable t) {
            return null;
        }
    }

    /** For a processing machine, the inventory slots its products appear in: {first, count}; null otherwise. */
    public static int[] outputSlots(TileEntity te) {
        Object m = meta(te);
        if (m == null || !basicClass.isInstance(m)) return null;
        try {
            Object[] out = (Object[]) outputItems.get(m);
            return new int[] { (Integer) outputSlot.invoke(m), out.length };
        } catch (Throwable t) {
            return null;
        }
    }

    public static boolean isActive(TileEntity te) {
        try {
            return meta(te) != null && (Boolean) active.invoke(te);
        } catch (Throwable t) {
            return false;
        }
    }

    public static JsonObject describe(TileEntity te) {
        Object m = meta(te);
        if (m == null) return null;
        JsonObject o = J.pos(te.xCoord, te.yCoord, te.zCoord);
        try {
            o.addProperty("name", (String) localName.invoke(m));
            if (basicClass.isInstance(m)) {
                Object map = recipeMap.invoke(m);
                if (map != null) {
                    String raw = (String) mapName.get(map);
                    String shown = StatCollector.translateToLocal(raw);
                    o.addProperty("recipes", shown == null || shown.isEmpty() || shown.equals(raw) ? raw : shown);
                }
                int t = tier.getByte(m);
                long volts = 8L << (2 * t);
                o.addProperty("tier", RecipeBook.tier((int) Math.min(Integer.MAX_VALUE, volts)));
                o.addProperty("inputSlots", inputCount.getInt(m));
            }
            boolean busy = (Boolean) active.invoke(te);
            o.addProperty("active", busy);
            int max = (Integer) maxProgress.invoke(te);
            if (max > 0) {
                o.addProperty("progress", (Integer) progress.invoke(te));
                o.addProperty("maxProgress", max);
            }
            o.addProperty("storedEU", (Long) storedEu.invoke(te));
            o.addProperty("inputVoltage", (Long) inputVoltage.invoke(te));
            if (!(Boolean) allowed.invoke(te)) o.addProperty("switchedOff", true);
        } catch (Throwable t) {
            o.addProperty("unreadable", true);
        }
        return o;
    }
}
