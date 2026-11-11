package alu.aiplayer.export;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.EnumChatFormatting;
import net.minecraft.world.World;
import net.minecraftforge.common.util.ForgeDirection;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import alu.aiplayer.AiPlayerMod;
import codechicken.nei.recipe.GuiCraftingRecipe;
import codechicken.nei.recipe.ICraftingHandler;

/**
 * Writes down how multiblock machines are built: for every controller NEI can preview, and every tier of it, the
 * blocks of the structure and the text of its tooltip.
 * <p>
 * Nothing stores these as data. The game builds a structure by running the machine's own construction code; the
 * NEI preview (BlockRenderer6343) does that in a throwaway world and draws the result. This does the same and
 * reads the throwaway world instead of drawing it. Everything is reached by name, so that the mod builds and runs
 * without those mods. Client only.
 */
final class StructureExport {

    private static final int OX = 0, OY = 120, OZ = 0;
    private static final int REACH = 56;
    private static final int MOST_TIERS = 16;
    private static final long BUDGET_MS = 20 * 60 * 1000L;

    private StructureExport() {}

    /** Returns how many structures were written; 0 when the preview mod is not there. */
    static int run(File dir) throws Exception {
        final Object handler = previewHandler();
        if (handler == null) {
            AiPlayerMod.LOG.info("export: no multiblock preview here, structures are left out");
            return 0;
        }
        List<?> controllers = (List<?>) handler.getClass()
            .getField("multiblocksList")
            .get(null);
        AiPlayerMod.LOG.info("export: {} multiblock controllers", controllers.size());
        File tmp = new File(dir, "structures.jsonl.part");
        int written = 0, failed = 0;
        long deadline = System.currentTimeMillis() + BUDGET_MS;
        try (Writer w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8), 1 << 16)) {
            for (final Object prototype : new ArrayList<Object>(controllers)) {
                if (System.currentTimeMillis() > deadline) {
                    AiPlayerMod.LOG.warn("export: structures cut short after {} controllers", written);
                    break;
                }
                try {
                    // The construction code expects the thread the game itself builds previews on.
                    Callable<List<JsonObject>> job = () -> controller(handler, prototype);
                    @SuppressWarnings("unchecked")
                    List<JsonObject> records = (List<JsonObject>) Minecraft.getMinecraft()
                        .func_152343_a(job)
                        .get(120, TimeUnit.SECONDS);
                    for (JsonObject o : records) {
                        w.write(o.toString());
                        w.write('\n');
                    }
                    if (!records.isEmpty()) written++;
                } catch (Throwable t) {
                    if (failed++ < 5) AiPlayerMod.LOG.warn("export: a structure could not be built: " + prototype.getClass().getName(), t);
                }
            }
        }
        java.nio.file.Files.move(
            tmp.toPath(),
            new File(dir, "structures.jsonl").toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        AiPlayerMod.LOG.info("export: {} multiblock structures, {} could not be built", written, failed);
        return written;
    }

    private static Object previewHandler() {
        try {
            Class<?> c = Class.forName("blockrenderer6343.integration.gregtech.GTNEIMultiblockHandler");
            List<ICraftingHandler> pages = new ArrayList<>(GuiCraftingRecipe.craftinghandlers);
            pages.addAll(GuiCraftingRecipe.serialCraftingHandlers);
            for (ICraftingHandler h : pages) if (c.isInstance(h)) return h;
        } catch (Throwable ignored) {}
        return null;
    }

    private static String plain(String s) {
        if (s == null) return "";
        String t = EnumChatFormatting.getTextWithoutFormattingCodes(s);
        return (t == null ? s : t).trim();
    }

    /** One controller at each of its tiers; tiers whose structure is the same are written once. */
    private static List<JsonObject> controller(Object handler, Object prototype) throws Exception {
        List<JsonObject> out = new ArrayList<>();
        ItemStack stack = (ItemStack) handler.getClass()
            .getMethod("getConstructableStack", Class.forName("com.gtnewhorizon.structurelib.alignment.constructable.IConstructable"))
            .invoke(handler, prototype);
        if (stack == null || stack.getItem() == null) return out;
        int maxTier = 1;
        try {
            Object data = Class.forName("blockrenderer6343.client.utils.ConstructableData")
                .getMethod("getTierData", Class.forName("com.gtnewhorizon.structurelib.alignment.constructable.IConstructable"))
                .invoke(null, prototype);
            maxTier = Math.max(1, (Integer) data.getClass()
                .getMethod("getMaxTotalTier")
                .invoke(data));
        } catch (Throwable ignored) {}
        JsonArray info = lines(prototype, "getInformation");
        JsonArray structureInfo = lines(prototype, "getStructureInformation");
        String lastShape = null;
        JsonObject last = null;
        for (int tier = 1; tier <= Math.min(maxTier, MOST_TIERS); tier++) {
            JsonObject shape;
            try {
                shape = build(stack, tier);
            } catch (Throwable t) {
                if (tier == 1) throw new Exception("tier 1 of " + plain(stack.getDisplayName()), t);
                break;
            }
            if (shape == null) continue;
            String key = shape.toString();
            if (key.equals(lastShape)) {
                last.getAsJsonArray("tiers")
                    .add(new JsonPrimitive(tier));
                continue;
            }
            JsonObject o = new JsonObject();
            o.addProperty("id", String.valueOf(Item.itemRegistry.getNameForObject(stack.getItem())));
            o.addProperty("meta", stack.getItemDamage());
            o.addProperty("name", plain(stack.getDisplayName()));
            JsonArray tiers = new JsonArray();
            tiers.add(new JsonPrimitive(tier));
            o.add("tiers", tiers);
            o.addProperty("maxTier", maxTier);
            for (Map.Entry<String, com.google.gson.JsonElement> e : shape.entrySet()) o.add(e.getKey(), e.getValue());
            if (out.isEmpty()) {
                if (info.size() > 0) o.add("info", info);
                if (structureInfo.size() > 0) o.add("structureInfo", structureInfo);
            }
            out.add(o);
            last = o;
            lastShape = key;
        }
        return out;
    }

    private static JsonArray lines(Object machine, String getter) {
        JsonArray a = new JsonArray();
        try {
            Method tooltip = null;
            for (Class<?> c = machine.getClass(); c != null && tooltip == null; c = c.getSuperclass()) {
                try {
                    tooltip = c.getDeclaredMethod("getTooltip");
                } catch (NoSuchMethodException ignored) {}
            }
            if (tooltip == null) return a;
            tooltip.setAccessible(true);
            Object builder = tooltip.invoke(machine);
            String[] text = (String[]) builder.getClass()
                .getMethod(getter)
                .invoke(builder);
            if (text != null) for (String line : text) {
                String t = plain(line);
                if (!t.isEmpty()) a.add(new JsonPrimitive(t));
            }
        } catch (Throwable ignored) {}
        return a;
    }

    /** Builds the structure at one tier in a throwaway world and reads it back: palette, runs, counts. */
    private static JsonObject build(ItemStack controllerItem, int tier) throws Exception {
        Class<?> worldClass = Class.forName("blockrenderer6343.client.world.TrackedDummyWorld");
        World world = (World) worldClass.getConstructor()
            .newInstance();
        EntityPlayer builder = (EntityPlayer) Class.forName("blockrenderer6343.client.utils.BRUtil")
            .getField("FAKE_PLAYER")
            .get(null);
        Class<?> updates = Class.forName("gregtech.api.threads.RunnableMachineUpdate");
        boolean was = (Boolean) updates.getMethod("isCurrentThreadEnabled")
            .invoke(null);
        updates.getMethod("setCurrentThreadEnabled", boolean.class)
            .invoke(null, false);
        try {
            ItemStack item = controllerItem.copy();
            item.getItem()
                .onItemUse(item, builder, world, OX, OY, OZ, 0, OX, OY, OZ);
            TileEntity te = world.getTileEntity(OX, OY, OZ);
            if (te == null) return null;
            te.getClass()
                .getMethod("setFrontFacing", ForgeDirection.class)
                .invoke(te, ForgeDirection.SOUTH);
            Object machine = te.getClass()
                .getMethod("getMetaTileEntity")
                .invoke(te);
            if (machine == null) return null;
            Item projector = (Item) Class.forName("com.gtnewhorizon.structurelib.StructureLibAPI")
                .getMethod("getDefaultHologramItem")
                .invoke(null);
            ItemStack trigger = new ItemStack(projector, tier);
            Class<?> survival = Class.forName("com.gtnewhorizon.structurelib.alignment.constructable.ISurvivalConstructable");
            Class<?> plainKind = Class.forName("com.gtnewhorizon.structurelib.alignment.constructable.IConstructable");
            Class<?> provider = Class.forName("com.gtnewhorizon.structurelib.alignment.constructable.IConstructableProvider");
            Method changed = worldClass.getMethod("hasChanged");
            if (survival.isInstance(machine)) {
                Class<?> envClass = Class.forName("com.gtnewhorizon.structurelib.structure.ISurvivalBuildEnvironment");
                Class<?> sourceClass = Class.forName("com.gtnewhorizon.structurelib.structure.IItemSource");
                Object source = Class.forName("blockrenderer6343.api.utils.CreativeItemSource")
                    .getField("instance")
                    .get(null);
                Object env = envClass.getMethod("create", sourceClass, EntityPlayer.class)
                    .invoke(null, source, builder);
                Method construct = survival.getMethod("survivalConstruct", ItemStack.class, int.class, envClass);
                // It places as much as one call allows; again until a call changes nothing more.
                for (int i = 0; i < 64; i++) {
                    int result = (Integer) construct.invoke(machine, trigger, Integer.MAX_VALUE, env);
                    boolean more = (Boolean) changed.invoke(world);
                    if (result == -1 || !more) break;
                }
            } else {
                Object c = provider.isInstance(machine) ? provider.getMethod("getConstructable")
                    .invoke(machine) : machine;
                if (!plainKind.isInstance(c)) return null;
                plainKind.getMethod("construct", ItemStack.class, boolean.class)
                    .invoke(c, trigger, false);
            }
            return read(world);
        } finally {
            updates.getMethod("setCurrentThreadEnabled", boolean.class)
                .invoke(null, was);
        }
    }

    private static JsonObject read(World world) {
        int x1 = Integer.MAX_VALUE, y1 = Integer.MAX_VALUE, z1 = Integer.MAX_VALUE, x2 = Integer.MIN_VALUE, y2 = Integer.MIN_VALUE, z2 = Integer.MIN_VALUE;
        int lo = Math.max(1, OY - REACH), hi = Math.min(255, OY + REACH);
        for (int y = lo; y <= hi; y++) for (int z = OZ - REACH; z <= OZ + REACH; z++) for (int x = OX - REACH; x <= OX + REACH; x++) {
            Block b = world.getBlock(x, y, z);
            if (b == null || b == net.minecraft.init.Blocks.air) continue;
            x1 = Math.min(x1, x);
            x2 = Math.max(x2, x);
            y1 = Math.min(y1, y);
            y2 = Math.max(y2, y);
            z1 = Math.min(z1, z);
            z2 = Math.max(z2, z);
        }
        if (x2 < x1) return null;
        Map<String, Integer> index = new LinkedHashMap<>();
        Map<Integer, Integer> counts = new LinkedHashMap<>();
        JsonArray palette = new JsonArray();
        JsonObject air = new JsonObject();
        air.addProperty("id", "minecraft:air");
        air.addProperty("meta", 0);
        palette.add(air);
        index.put("minecraft:air/0", 0);
        List<String> names = new ArrayList<>();
        names.add("");
        JsonArray runs = new JsonArray();
        int last = -1, run = 0;
        for (int y = y1; y <= y2; y++) for (int z = z1; z <= z2; z++) for (int x = x1; x <= x2; x++) {
            Block b = world.getBlock(x, y, z);
            int i = 0;
            if (b != null && b != net.minecraft.init.Blocks.air) {
                int meta = world.getBlockMetadata(x, y, z);
                String id = String.valueOf(Block.blockRegistry.getNameForObject(b));
                // A machine part is told apart by the item it is as, not by the block all of them share.
                String name;
                int shownMeta = meta;
                try {
                    ItemStack picked = b.getPickBlock(null, world, x, y, z, null);
                    if (picked == null) picked = new ItemStack(b, 1, meta);
                    name = plain(picked.getDisplayName());
                    if (picked.getItem() == Item.getItemFromBlock(b)) shownMeta = picked.getItemDamage();
                } catch (Throwable t) {
                    name = id;
                }
                String key = id + "/" + shownMeta;
                Integer known = index.get(key);
                if (known == null) {
                    JsonObject o = new JsonObject();
                    o.addProperty("id", id);
                    o.addProperty("meta", shownMeta);
                    o.addProperty("name", name);
                    palette.add(o);
                    known = palette.size() - 1;
                    index.put(key, known);
                    names.add(name);
                }
                i = known;
                counts.merge(i, 1, Integer::sum);
            }
            if (i == last) {
                run++;
            } else {
                if (run > 0) {
                    runs.add(new JsonPrimitive(last));
                    runs.add(new JsonPrimitive(run));
                }
                last = i;
                run = 1;
            }
        }
        if (run > 0) {
            runs.add(new JsonPrimitive(last));
            runs.add(new JsonPrimitive(run));
        }
        JsonObject o = new JsonObject();
        JsonArray size = new JsonArray();
        size.add(new JsonPrimitive(x2 - x1 + 1));
        size.add(new JsonPrimitive(y2 - y1 + 1));
        size.add(new JsonPrimitive(z2 - z1 + 1));
        o.add("size", size);
        JsonArray at = new JsonArray();
        at.add(new JsonPrimitive(OX - x1));
        at.add(new JsonPrimitive(OY - y1));
        at.add(new JsonPrimitive(OZ - z1));
        o.add("controller", at);
        o.addProperty("facing", "south");
        JsonArray need = new JsonArray();
        for (Map.Entry<Integer, Integer> e : counts.entrySet()) {
            JsonObject n = new JsonObject();
            JsonObject p = palette.get(e.getKey())
                .getAsJsonObject();
            n.add("id", p.get("id"));
            n.add("meta", p.get("meta"));
            n.add("name", p.get("name"));
            n.addProperty("n", e.getValue());
            need.add(n);
        }
        o.add("blocks", need);
        o.add("palette", palette);
        o.add("runs", runs);
        return o;
    }
}
