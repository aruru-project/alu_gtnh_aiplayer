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
    // ---- covers ---------------------------------------------------------------------------------------------------

    public static final String[] SIDES = { "down", "up", "north", "south", "west", "east" };

    private static boolean coversLooked;
    private static Class<?> coverable;
    private static Method hasCover, coverItem, coverAt;

    private static synchronized boolean coversAvailable() {
        if (coversLooked) return coverable != null;
        coversLooked = true;
        try {
            Class<?> c = Class.forName("gregtech.api.interfaces.tileentity.ICoverable");
            Class<?> dir = net.minecraftforge.common.util.ForgeDirection.class;
            hasCover = c.getMethod("hasCoverAtSide", dir);
            coverItem = c.getMethod("getCoverItemAtSide", dir);
            coverAt = c.getMethod("getCoverAtSide", dir);
            coverable = c;
        } catch (Throwable t) {
            coverable = null;
        }
        return coverable != null;
    }

    /** A cover on one face of a machine: the item it is, and what it holds if it is one that holds things. */
    public static final class Cover {

        public int side;
        public ItemStack item;
        /** Whether sneaking and right-clicking that face opens a screen of its own. */
        public boolean screen;
        /** Null when the cover holds nothing; the stacks otherwise (null entries for empty slots). */
        public ItemStack[] holds;
    }

    /** The covers on a block's faces; empty for anything that takes no covers. */
    public static java.util.List<Cover> covers(TileEntity te) {
        java.util.List<Cover> out = new java.util.ArrayList<>();
        if (te == null || !coversAvailable() || !coverable.isInstance(te)) return out;
        for (int side = 0; side < 6; side++) {
            try {
                Object dir = net.minecraftforge.common.util.ForgeDirection.getOrientation(side);
                if (!(Boolean) hasCover.invoke(te, dir)) continue;
                Cover c = new Cover();
                c.side = side;
                c.item = (ItemStack) coverItem.invoke(te, dir);
                Object cover = coverAt.invoke(te, dir);
                if (cover != null) {
                    try {
                        c.screen = (Boolean) cover.getClass()
                            .getMethod("hasCoverGUI")
                            .invoke(cover);
                    } catch (Throwable ignored) {}
                    // A cover that keeps items says so with getItems(): an item handler of some slots.
                    try {
                        Object handler = cover.getClass()
                            .getMethod("getItems")
                            .invoke(cover);
                        if (handler != null) {
                            int n = (Integer) handler.getClass()
                                .getMethod("getSlots")
                                .invoke(handler);
                            Method get = handler.getClass()
                                .getMethod("getStackInSlot", int.class);
                            get.setAccessible(true);
                            c.holds = new ItemStack[Math.max(0, Math.min(n, 512))];
                            for (int i = 0; i < c.holds.length; i++) c.holds[i] = (ItemStack) get.invoke(handler, i);
                        }
                    } catch (NoSuchMethodException none) {
                        // most covers hold nothing
                    } catch (Throwable ignored) {}
                }
                if (c.item != null) out.add(c);
            } catch (Throwable ignored) {}
        }
        return out;
    }

    /**
     * What a block says about itself to a scanner: the lines a player reads off a portable scanner held to it.
     * Machines that give such information write them themselves, so nothing is known here about any kind.
     */
    public static com.google.gson.JsonArray says(TileEntity te) {
        com.google.gson.JsonArray out = new com.google.gson.JsonArray();
        if (te == null) return out;
        try {
            Class<?> info = Class.forName("gregtech.api.interfaces.tileentity.IGregTechDeviceInformation");
            if (!info.isInstance(te)) return out;
            if (!(Boolean) info.getMethod("isGivingInformation")
                .invoke(te)) return out;
            String[] lines = (String[]) info.getMethod("getInfoData")
                .invoke(te);
            if (lines == null) return out;
            Method toComponent = null;
            try {
                toComponent = info.getMethod("toComponent", String.class);
            } catch (Throwable ignored) {}
            for (String line : lines) {
                if (line == null) continue;
                String text = line;
                // Lines may carry a translation key in place of text; the game turns it into words.
                if (toComponent != null) {
                    try {
                        Object c = toComponent.invoke(null, line);
                        if (c instanceof net.minecraft.util.IChatComponent) text = ((net.minecraft.util.IChatComponent) c).getUnformattedText();
                    } catch (Throwable ignored) {}
                }
                // (The game's own stripping of colour codes exists on the client only.)
                String plain = text.replaceAll("\u00a7.", "")
                    .trim();
                if (!plain.isEmpty() && out.size() < 60) out.add(new com.google.gson.JsonPrimitive(plain));
            }
        } catch (Throwable ignored) {}
        return out;
    }

    /** What a block's tanks hold, for anything that handles fluids: [{fluid, name, amount, capacity}]. */
    public static com.google.gson.JsonArray tanks(TileEntity te) {
        com.google.gson.JsonArray out = new com.google.gson.JsonArray();
        if (!(te instanceof net.minecraftforge.fluids.IFluidHandler)) return out;
        java.util.Set<String> seen = new java.util.HashSet<>();
        try {
            // A machine may answer differently for each face; asked from every side, each tank is listed once.
            for (int side = 6; side >= 0; side--) {
                net.minecraftforge.fluids.FluidTankInfo[] info = ((net.minecraftforge.fluids.IFluidHandler) te)
                    .getTankInfo(net.minecraftforge.common.util.ForgeDirection.getOrientation(side));
                if (info == null) continue;
                for (int i = 0; i < info.length; i++) {
                    net.minecraftforge.fluids.FluidTankInfo t = info[i];
                    if (t == null) continue;
                    net.minecraftforge.fluids.FluidStack f = t.fluid;
                    String key = i + "|" + (f == null ? "" : f.getFluid().getName() + "|" + f.amount) + "|" + t.capacity;
                    if (!seen.add(key)) continue;
                    out.add(tank(f, t.capacity));
                }
            }
        } catch (Throwable ignored) {}
        return out;
    }

    /** One tank as {fluid, name, amount, capacity}; an empty one has only amount 0 and its capacity. */
    public static JsonObject tank(net.minecraftforge.fluids.FluidStack f, int capacity) {
        JsonObject o = new JsonObject();
        if (f != null && f.getFluid() != null && f.amount > 0) {
            o.addProperty("fluid", f.getFluid().getName());
            o.addProperty("name", f.getLocalizedName());
            o.addProperty("amount", f.amount);
        } else {
            o.addProperty("amount", 0);
        }
        o.addProperty("capacity", capacity);
        return o;
    }

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

    /**
     * What a slot of a GregTech machine or bus is for, by its index in the machine's inventory: "input" (where a
     * recipe's ingredients go), "output" (where products appear), "special" (the one extra slot some machines read,
     * such as a mold or a data stick), "circuit" (the programmed-circuit setting), "battery" (a battery that powers
     * the machine, or that it charges); null when it is none of these.
     */
    public static String slotRole(TileEntity te, int index) {
        Object m = meta(te);
        if (m == null) return null;
        int[] in = inputSlots(te), out = outputSlots(te);
        boolean bus = in != null && out != null && in[0] == out[0] && in[1] == out[1];
        if (!bus && in != null && index >= in[0] && index < in[0] + in[1]) return "input";
        if (!bus && out != null && index >= out[0] && index < out[0] + out[1]) return "output";
        if (bus && index >= in[0] && index < in[0] + in[1]) return portKind(te) != null && portKind(te).startsWith("output") ? "output" : "input";
        try {
            if (basicClass.isInstance(m)) {
                if (index == (Integer) m.getClass()
                    .getMethod("getSpecialSlotIndex")
                    .invoke(m)) return "special";
                if (index == (Integer) m.getClass()
                    .getMethod("getCircuitSlot")
                    .invoke(m)) return "circuit";
                if (index == (Integer) m.getClass()
                    .getMethod("rechargerSlotStartIndex")
                    .invoke(m)) return "battery";
            }
        } catch (Throwable ignored) {}
        return null;
    }

    /**
     * Whether a slot of an open screen is one of the machine's own: its item handler is the machine's inventory.
     * A cover's slots, shown on the same screen, belong to the cover.
     */
    public static boolean ownSlot(TileEntity te, net.minecraft.inventory.Slot slot) {
        Object m = meta(te);
        if (m == null) return false;
        try {
            Object own = m.getClass()
                .getMethod("getInventoryHandler")
                .invoke(m);
            Object handler = slot.getClass()
                .getMethod("getItemHandler")
                .invoke(slot);
            return own != null && handler == own;
        } catch (Throwable t) {
            // A screen not built from item handlers: its slots are the block's inventory, as for a plain chest.
            return slot.inventory == te;
        }
    }

    /**
     * What a GregTech machine set out to make when it started the recipe it is running: the products it will put
     * out (single-block machines and multiblocks keep them from the start). Empty when it is idle or cannot be read.
     */
    public static com.google.gson.JsonArray making(TileEntity te) {
        com.google.gson.JsonArray out = new com.google.gson.JsonArray();
        Object m = meta(te);
        if (m == null) return out;
        try {
            Object[] items = (Object[]) m.getClass()
                .getField("mOutputItems")
                .get(m);
            if (items == null) return out;
            for (Object o : items) {
                if (!(o instanceof net.minecraft.item.ItemStack)) continue;
                net.minecraft.item.ItemStack s = (net.minecraft.item.ItemStack) o;
                if (s.getItem() == null || s.stackSize <= 0) continue;
                out.add(alu.aiplayer.util.Names.describe(s));
            }
        } catch (Throwable ignored) {}
        return out;
    }

    public static boolean isActive(TileEntity te) {
        try {
            return meta(te) != null && (Boolean) active.invoke(te);
        } catch (Throwable t) {
            return false;
        }
    }

    /** How far into its recipe it is, in ticks (negative while it waits after running out of power); 0 if unreadable. */
    public static int progress(TileEntity te) {
        try {
            return meta(te) == null ? 0 : (Integer) progress.invoke(te);
        } catch (Throwable t) {
            return 0;
        }
    }

    /** How long the recipe it is running takes, in ticks; 0 when it runs none (or this cannot be read). */
    public static int maxProgress(TileEntity te) {
        try {
            return meta(te) == null ? 0 : (Integer) maxProgress.invoke(te);
        } catch (Throwable t) {
            return 0;
        }
    }

    /** Whether it may work: false once it has been switched off, or has shut itself down (a multiblock losing power). */
    public static boolean allowedToWork(TileEntity te) {
        try {
            return meta(te) != null && (Boolean) allowed.invoke(te);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * Something that stays the same while the machine runs one recipe and is another object for the next: the first
     * product it keeps for that recipe (a fresh copy every time it starts one). Null when it keeps none.
     */
    public static Object recipeToken(TileEntity te) {
        Object m = meta(te);
        if (m == null) return null;
        try {
            Object[] items = (Object[]) m.getClass()
                .getField("mOutputItems")
                .get(m);
            if (items != null) for (Object o : items) if (o != null) return o;
        } catch (Throwable ignored) {}
        return null;
    }

    /**
     * A single-block machine's auto-output, as its screen's two switches set it: whether it pushes the items and the
     * fluids it makes out of its output face by itself, which face that is and what stands against it. Null for
     * anything else, and when both switches are off.
     */
    public static JsonObject autoOutput(TileEntity te) {
        Object m = meta(te);
        if (m == null || !basicClass.isInstance(m)) return null;
        try {
            boolean items = (Boolean) m.getClass()
                .getMethod("doesAutoOutput")
                .invoke(m);
            boolean fluids = (Boolean) m.getClass()
                .getMethod("doesAutoOutputFluids")
                .invoke(m);
            if (!items && !fluids) return null;
            JsonObject o = new JsonObject();
            o.addProperty("items", items);
            o.addProperty("fluids", fluids);
            Object front = te.getClass()
                .getMethod("getFrontFacing")
                .invoke(te);
            Object main = m.getClass()
                .getField("mMainFacing")
                .get(m);
            int side = front instanceof Enum ? ((Enum<?>) front).ordinal() : -1;
            if (side < 0 || side > 5) return o;
            // The machine pushes nothing while its output face is the face it shows its front on.
            if (front == main) {
                o.addProperty("outputFaceIsFront", true);
                return o;
            }
            o.addProperty("side", SIDES[side]);
            net.minecraftforge.common.util.ForgeDirection d = net.minecraftforge.common.util.ForgeDirection.getOrientation(side);
            int x = te.xCoord + d.offsetX, y = te.yCoord + d.offsetY, z = te.zCoord + d.offsetZ;
            net.minecraft.world.World w = te.getWorldObj();
            if (w != null && w.blockExists(x, y, z) && !w.isAirBlock(x, y, z)) {
                JsonObject to = J.pos(x, y, z);
                TileEntity there = w.getTileEntity(x, y, z);
                String name = there == null ? null : name(there);
                to.addProperty("name", name != null ? name : alu.aiplayer.world.WorldQueries.blockName(w.getBlock(x, y, z), w.getBlockMetadata(x, y, z)));
                o.add("to", to);
            }
            return o;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Whether it is running a recipe right now: active and with a recipe's length set. The active flag alone lingers
     * a moment after a recipe ends, so a machine that just finished one looks busy before it has started the next.
     */
    public static boolean working(TileEntity te) {
        try {
            return isActive(te) && (Integer) maxProgress.invoke(te) > 0;
        } catch (Throwable t) {
            return false;
        }
    }

    public static JsonObject describe(TileEntity te) {
        JsonObject o = describeMachine(te);
        if (o != null) attachments(o, te);
        return o;
    }

    /** What is on and in a block besides its item slots: the covers on its faces and what its tanks hold. */
    public static void attachments(JsonObject o, TileEntity te) {
        com.google.gson.JsonArray covers = coversJson(te, 60);
        if (covers.size() > 0) o.add("covers", covers);
        com.google.gson.JsonArray tanks = tanks(te);
        if (tanks.size() > 0) o.add("tanks", tanks);
    }

    /** The covers as data: [{side, id, meta, name, screen?, slots?, usedSlots?, items?, moreKinds?}]. */
    public static com.google.gson.JsonArray coversJson(TileEntity te, int kinds) {
        com.google.gson.JsonArray out = new com.google.gson.JsonArray();
        for (Cover c : covers(te)) {
            JsonObject j = new JsonObject();
            j.addProperty("side", SIDES[c.side]);
            j.addProperty("id", alu.aiplayer.util.Names.itemId(c.item.getItem()));
            j.addProperty("meta", c.item.getItemDamage());
            j.addProperty("name", alu.aiplayer.util.Names.displayName(c.item));
            if (c.screen) j.addProperty("screen", true);
            if (c.holds != null) {
                java.util.Map<String, JsonObject> merged = new java.util.LinkedHashMap<>();
                int used = 0;
                for (ItemStack st : c.holds) {
                    if (st == null || st.stackSize <= 0) continue;
                    used++;
                    String key = alu.aiplayer.util.Names.itemId(st.getItem()) + "@" + alu.aiplayer.util.Names.meta(st);
                    JsonObject item = merged.get(key);
                    if (item == null) {
                        item = alu.aiplayer.util.Names.describe(st);
                        item.remove("durability");
                        merged.put(key, item);
                    } else {
                        item.addProperty("count", item.get("count").getAsInt() + st.stackSize);
                    }
                }
                j.addProperty("slots", c.holds.length);
                j.addProperty("usedSlots", used);
                com.google.gson.JsonArray items = new com.google.gson.JsonArray();
                for (JsonObject item : merged.values()) {
                    if (items.size() >= kinds) break;
                    items.add(item);
                }
                j.add("items", items);
                if (merged.size() > items.size()) j.addProperty("moreKinds", merged.size() - items.size());
            }
            out.add(j);
        }
        return out;
    }

    private static JsonObject describeMachine(TileEntity te) {
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
                try {
                    o.addProperty("outputSlots", ((Object[]) outputItems.get(m)).length);
                } catch (Throwable ignored) {}
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
            JsonObject auto = autoOutput(te);
            if (auto != null) o.add("autoOutput", auto);
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
