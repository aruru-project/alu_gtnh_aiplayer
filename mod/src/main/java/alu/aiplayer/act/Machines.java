package alu.aiplayer.act;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import net.minecraft.item.ItemStack;
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
    private static Method stackForm;
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
            stackForm = meta.getMethod("getStackForm", long.class);
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
        // The item's name is the one players know; pipes and cables have no other.
        ItemStack item = item(te);
        if (item != null) {
            try {
                String shown = item.getDisplayName();
                if (shown != null && !shown.isEmpty() && !shown.endsWith(".name")) return shown;
            } catch (Throwable ignored) {}
        }
        try {
            return (String) localName.invoke(m);
        } catch (Throwable t) {
            return null;
        }
    }

    /** The block as an item, which is how recipe pages and inventories name it; null if this is not GregTech. */
    public static ItemStack item(TileEntity te) {
        Object m = meta(te);
        if (m == null) return null;
        try {
            return (ItemStack) stackForm.invoke(m, 1L);
        } catch (Throwable t) {
            return null;
        }
    }

    /** "item pipe" or "fluid pipe" for GregTech pipes, null for everything else (cables included). */
    public static String pipeKind(TileEntity te) {
        Object m = meta(te);
        if (m == null) return null;
        String c = m.getClass()
            .getSimpleName();
        if (c.contains("ItemPipe")) return "item pipe";
        if (c.contains("Fluid") && c.contains("Pipe")) return "fluid pipe";
        return null;
    }

    /** For a processing machine, the inventory slots that take input: {first, count}; null otherwise. */
    public static int[] inputSlots(TileEntity te) {
        Object m = meta(te);
        if (m == null) return null;
        int[] port = portSlots(te, m, true);
        if (port != null) return port;
        if (!basicClass.isInstance(m)) return null;
        try {
            return new int[] { (Integer) inputSlot.invoke(m), inputCount.getInt(m) };
        } catch (Throwable t) {
            return null;
        }
    }

    /** For a processing machine, the inventory slots its products appear in: {first, count}; null otherwise. */
    public static int[] outputSlots(TileEntity te) {
        Object m = meta(te);
        if (m == null) return null;
        int[] port = portSlots(te, m, false);
        if (port != null) return port;
        if (!basicClass.isInstance(m)) return null;
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
        if (isMultiblock(te)) return describeMultiblock(te, m);
        JsonObject o = J.pos(te.xCoord, te.yCoord, te.zCoord);
        try {
            o.addProperty("name", name(te));
            ItemStack item = item(te);
            if (item != null && item.getItem() != null) {
                // Recipe pages list the machines that run them as items; this is the same pair.
                o.addProperty("id", alu.aiplayer.util.Names.itemId(item.getItem()));
                o.addProperty("meta", item.getItemDamage());
            }
            if (basicClass.isInstance(m)) {
                Object map = recipeMap.invoke(m);
                if (map != null) {
                    String raw = (String) mapName.get(map);
                    String shown = StatCollector.translateToLocal(raw);
                    o.addProperty("recipes", shown == null || shown.isEmpty() || shown.equals(raw) ? raw : shown);
                    o.addProperty("recipeKey", raw);
                }
                int circuit = circuit(te);
                if (circuit > 0) o.addProperty("circuit", circuit);
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

    // ---- multiblock machines --------------------------------------------------------------------------------

    private static boolean lookedMulti;
    private static boolean usableMulti;
    private static Class<?> multiClass, inBusClass, outBusClass, inHatchClass, outHatchClass, circuitClass;
    private static Field inBuses, outBuses, inHatches, outHatches, formed;
    private static Method baseOf, multiRecipeMap, ideal, repair, maxVoltage, checkResult, circuitSlot, circuitAllowed;
    private static Method tankIn, tankOut, tankFluid, tankCapacity, makeCircuit;

    private static synchronized boolean multi() {
        if (lookedMulti) return usableMulti;
        lookedMulti = true;
        if (!available()) return false;
        try {
            String impl = "gregtech.api.metatileentity.implementations.";
            multiClass = Class.forName(impl + "MTEMultiBlockBase");
            inBusClass = Class.forName(impl + "MTEHatchInputBus");
            outBusClass = Class.forName(impl + "MTEHatchOutputBus");
            inHatchClass = Class.forName(impl + "MTEHatchInput");
            outHatchClass = Class.forName(impl + "MTEHatchOutput");
            Class<?> tank = Class.forName(impl + "MTEBasicTank");
            circuitClass = Class.forName("gregtech.api.interfaces.IConfigurationCircuitSupport");
            inBuses = multiClass.getField("mInputBusses");
            outBuses = multiClass.getField("mOutputBusses");
            inHatches = multiClass.getField("mInputHatches");
            outHatches = multiClass.getField("mOutputHatches");
            formed = multiClass.getField("mMachine");
            baseOf = Class.forName("gregtech.api.metatileentity.MetaTileEntity")
                .getMethod("getBaseMetaTileEntity");
            multiRecipeMap = multiClass.getMethod("getRecipeMap");
            ideal = multiClass.getMethod("getIdealStatus");
            repair = multiClass.getMethod("getRepairStatus");
            maxVoltage = multiClass.getMethod("getMaxInputVoltage");
            checkResult = multiClass.getMethod("getCheckRecipeResult");
            circuitSlot = circuitClass.getMethod("getCircuitSlot");
            circuitAllowed = circuitClass.getMethod("allowSelectCircuit");
            tankIn = tank.getMethod("getInputSlot");
            tankOut = tank.getMethod("getOutputSlot");
            tankFluid = tank.getMethod("getFluid");
            tankCapacity = tank.getMethod("getCapacity");
            makeCircuit = Class.forName("gregtech.api.util.GTUtility")
                .getMethod("getIntegratedCircuit", int.class);
            usableMulti = true;
        } catch (Throwable t) {
            usableMulti = false;
            AiPlayerMod.LOG.warn("GregTech's multiblock machines are not in a form this mod knows; they go unused", t);
        }
        return usableMulti;
    }

    /** Whether the block is the controller of a multiblock machine. */
    public static boolean isMultiblock(TileEntity te) {
        Object m = meta(te);
        return m != null && multi() && multiClass.isInstance(m);
    }

    /** Anything {@code process} can run: a single-block processing machine or a multiblock's controller. */
    public static boolean isRunnable(TileEntity te) {
        return isProcessor(te) || isMultiblock(te);
    }

    /** "input bus", "output bus", "input hatch" or "output hatch" for those parts of a multiblock; else null. */
    public static String portKind(TileEntity te) {
        Object m = meta(te);
        if (m == null || !multi()) return null;
        if (inBusClass.isInstance(m)) return "input bus";
        if (outBusClass.isInstance(m)) return "output bus";
        if (inHatchClass.isInstance(m)) return "input hatch";
        if (outHatchClass.isInstance(m)) return "output hatch";
        return null;
    }

    /**
     * The slots of a bus or hatch that a hand reaches: all of a bus but its circuit slot; of a hatch, the slot
     * a cell goes in (to be emptied or filled) and the slot it comes out of.
     */
    private static int[] portSlots(TileEntity te, Object m, boolean putting) {
        if (!multi() || !(te instanceof net.minecraft.inventory.IInventory)) return null;
        try {
            int size = ((net.minecraft.inventory.IInventory) te).getSizeInventory();
            if (inBusClass.isInstance(m)) {
                int c = (Integer) circuitSlot.invoke(m);
                return new int[] { 0, c > 0 && c < size ? c : size };
            }
            if (outBusClass.isInstance(m)) return new int[] { 0, size };
            if (inHatchClass.isInstance(m) || outHatchClass.isInstance(m)) {
                return new int[] { (Integer) (putting ? tankIn : tankOut).invoke(m), 1 };
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /** The buses or hatches of one kind that a formed multiblock has found for itself. */
    public static java.util.List<TileEntity> ports(TileEntity controller, String kind) {
        java.util.List<TileEntity> out = new java.util.ArrayList<>();
        Object m = meta(controller);
        if (m == null || !isMultiblock(controller)) return out;
        // Every list of parts the controller keeps, whatever it is called: steam machines and add-ons keep their
        // buses in lists of their own, and a part is known by what it is, not by which list it sits in.
        java.util.Set<TileEntity> seen = new java.util.HashSet<>();
        for (Class<?> c = m.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
            for (Field f : c.getDeclaredFields()) {
                if (java.lang.reflect.Modifier.isStatic(f.getModifiers()) || !java.util.Collection.class.isAssignableFrom(f.getType())) continue;
                try {
                    f.setAccessible(true);
                    Object value = f.get(m);
                    if (!(value instanceof java.util.Collection)) continue;
                    for (Object part : new java.util.ArrayList<Object>((java.util.Collection<?>) value)) {
                        if (part == null || !baseOf.getDeclaringClass()
                            .isInstance(part)) continue;
                        Object base = baseOf.invoke(part);
                        if (!(base instanceof TileEntity) || ((TileEntity) base).isInvalid()) continue;
                        TileEntity te = (TileEntity) base;
                        if (kind.equals(portKind(te)) && seen.add(te)) out.add(te);
                    }
                } catch (Throwable ignored) {}
            }
        }
        return out;
    }

    /** The programmed-circuit setting of a machine or input bus: 0 for none, -1 if it has no such setting. */
    public static int circuit(TileEntity te) {
        Object m = meta(te);
        if (m == null || !multi() || !circuitClass.isInstance(m) || !(te instanceof net.minecraft.inventory.IInventory)) return -1;
        try {
            if (!(Boolean) circuitAllowed.invoke(m)) return -1;
            ItemStack s = ((net.minecraft.inventory.IInventory) te).getStackInSlot((Integer) circuitSlot.invoke(m));
            return s == null ? 0 : s.getItemDamage();
        } catch (Throwable t) {
            return -1;
        }
    }

    /**
     * Sets the programmed circuit, as clicking the circuit slot of the machine's screen does: no item is used up.
     * 0 clears it. False if this block has no such setting.
     */
    public static boolean setCircuit(TileEntity te, int number) {
        Object m = meta(te);
        if (circuit(te) < 0) return false;
        try {
            ItemStack s = number <= 0 ? null : (ItemStack) makeCircuit.invoke(null, number);
            if (number > 0 && s == null) return false;
            ((net.minecraft.inventory.IInventory) te).setInventorySlotContents((Integer) circuitSlot.invoke(m), s);
            te.markDirty();
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** Why a multiblock is not working, in the words its own screen uses; null when it has no complaint. */
    public static String idleReason(TileEntity te) {
        Object m = meta(te);
        if (m == null || !isMultiblock(te)) return null;
        try {
            if (!formed.getBoolean(m)) return "the structure is incomplete";
            int broken = (Integer) ideal.invoke(m) - (Integer) repair.invoke(m);
            Object result = checkResult.invoke(m);
            String said = null;
            if (result != null && !(Boolean) result.getClass()
                .getMethod("wasSuccessful")
                .invoke(result)) {
                try {
                    Method shown = result.getClass()
                        .getMethod("getDisplayString");
                    shown.setAccessible(true);
                    Object text = shown.invoke(result);
                    if (text != null) said = String.valueOf(text)
                        .replaceAll("\u00a7.", "")
                        .trim();
                } catch (Throwable ignored) {}
            }
            if (broken > 0) return (said == null || said.isEmpty() ? "" : said + "; ") + broken + " maintenance problem(s) need fixing";
            return said == null || said.isEmpty() ? null : said;
        } catch (Throwable t) {
            return null;
        }
    }

    private static JsonObject describeMultiblock(TileEntity te, Object m) {
        JsonObject o = J.pos(te.xCoord, te.yCoord, te.zCoord);
        try {
            o.addProperty("name", name(te));
            ItemStack item = item(te);
            if (item != null && item.getItem() != null) {
                o.addProperty("id", alu.aiplayer.util.Names.itemId(item.getItem()));
                o.addProperty("meta", item.getItemDamage());
            }
            o.addProperty("kind", "multiblock");
            boolean whole = formed.getBoolean(m);
            o.addProperty("formed", whole);
            Object map = multiRecipeMap.invoke(m);
            if (map != null) {
                String raw = (String) mapName.get(map);
                String shown = StatCollector.translateToLocal(raw);
                o.addProperty("recipes", shown == null || shown.isEmpty() || shown.equals(raw) ? raw : shown);
                o.addProperty("recipeKey", raw);
            }
            if (whole) {
                long volts = (Long) maxVoltage.invoke(m);
                o.addProperty("inputVoltage", volts);
                o.addProperty("tier", RecipeBook.tier((int) Math.min(Integer.MAX_VALUE, Math.max(1, volts))));
                Integer heat = heat(m);
                if (heat != null && heat > 0) o.addProperty("heat", heat);
            }
            boolean busy = (Boolean) active.invoke(te);
            o.addProperty("active", busy);
            int max = (Integer) maxProgress.invoke(te);
            if (max > 0) {
                o.addProperty("progress", (Integer) progress.invoke(te));
                o.addProperty("maxProgress", max);
            }
            if (!(Boolean) allowed.invoke(te)) o.addProperty("switchedOff", true);
            String why = busy ? null : idleReason(te);
            if (why != null) o.addProperty("idleReason", why);
            for (String kind : new String[] { "input bus", "output bus", "input hatch", "output hatch" }) {
                com.google.gson.JsonArray list = new com.google.gson.JsonArray();
                for (TileEntity part : ports(te, kind)) list.add(describePort(part));
                String key = kind.startsWith("input") ? (kind.endsWith("bus") ? "inputBuses" : "inputHatches")
                    : (kind.endsWith("bus") ? "outputBuses" : "outputHatches");
                o.add(key, list);
            }
        } catch (Throwable t) {
            o.addProperty("unreadable", true);
        }
        return o;
    }

    /** A bus or hatch: where it is, how full, and for a hatch what fluid is in it. */
    public static JsonObject describePort(TileEntity part) {
        JsonObject o = J.pos(part.xCoord, part.yCoord, part.zCoord);
        Object m = meta(part);
        try {
            o.addProperty("name", name(part));
            String kind = portKind(part);
            if (kind != null) o.addProperty("kind", kind);
            if (kind != null && kind.endsWith("bus")) {
                net.minecraft.inventory.IInventory inv = (net.minecraft.inventory.IInventory) part;
                int[] range = portSlots(part, m, true);
                int used = 0;
                for (int i = 0; i < range[1]; i++) if (inv.getStackInSlot(range[0] + i) != null) used++;
                o.addProperty("slots", range[1]);
                o.addProperty("usedSlots", used);
                int circuit = circuit(part);
                if (circuit > 0) o.addProperty("circuit", circuit);
                if (kind.startsWith("output")) {
                    com.google.gson.JsonArray on = new com.google.gson.JsonArray();
                    for (TileEntity next : alu.aiplayer.world.WorldQueries.passesTo(part.getWorldObj(), part)) {
                        JsonObject c = J.pos(next.xCoord, next.yCoord, next.zCoord);
                        c.addProperty(
                            "name",
                            alu.aiplayer.world.WorldQueries.blockName(next.getBlockType(), next.getBlockMetadata()));
                        on.add(c);
                    }
                    if (on.size() > 0) o.add("passesTo", on);
                }
            } else if (kind != null) {
                net.minecraftforge.fluids.FluidStack f = (net.minecraftforge.fluids.FluidStack) tankFluid.invoke(m);
                o.addProperty("capacity", (Integer) tankCapacity.invoke(m));
                if (f != null && f.amount > 0 && f.getFluid() != null) {
                    o.addProperty(
                        "fluid",
                        f.getFluid()
                            .getName());
                    o.addProperty("fluidName", f.getLocalizedName());
                    o.addProperty("amount", f.amount);
                }
            }
        } catch (Throwable t) {
            o.addProperty("unreadable", true);
        }
        try {
            com.google.gson.JsonArray attached = alu.aiplayer.world.WorldQueries.attached(part.getWorldObj(), part);
            if (attached.size() > 0) o.add("attached", attached);
        } catch (Throwable ignored) {}
        return o;
    }

    /** The coil heat of a blast furnace and its relatives, which decides which of their recipes they can run. */
    private static Integer heat(Object m) {
        for (Class<?> c = m.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField("mHeatingCapacity");
                f.setAccessible(true);
                Object v = f.get(m);
                if (v instanceof Integer) return (Integer) v;
                if (v != null) {
                    try {
                        Object heat = v.getClass()
                            .getMethod("getHeat")
                            .invoke(v);
                        if (heat instanceof Number) return ((Number) heat).intValue();
                    } catch (Throwable ignored) {}
                }
                return null;
            } catch (NoSuchFieldException e) {
                // keep looking up the class chain
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }
}
