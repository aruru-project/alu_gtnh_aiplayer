package alu.aiplayer.export;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.util.EnumChatFormatting;
import net.minecraftforge.fluids.FluidStack;
import net.minecraftforge.oredict.OreDictionary;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import alu.aiplayer.AiPlayerMod;
import codechicken.nei.ItemList;
import codechicken.nei.PositionedStack;
import codechicken.nei.recipe.GuiCraftingRecipe;
import codechicken.nei.recipe.GuiRecipeTab;
import codechicken.nei.recipe.HandlerInfo;
import codechicken.nei.recipe.ICraftingHandler;
import codechicken.nei.recipe.IRecipeHandler;
import codechicken.nei.recipe.RecipeCatalysts;
import codechicken.nei.recipe.ShapedRecipeHandler;
import codechicken.nei.recipe.ShapelessRecipeHandler;
import codechicken.nei.recipe.TemplateRecipeHandler;

/**
 * Writes down what NEI shows: every item and every recipe of every recipe page, in the language the client runs in.
 * <p>
 * Recipes are registered in memory when the game starts and each mod brings the code that lays its own kind out for
 * NEI. That code only exists in a client, so this runs in one, once per version of the pack; the brain then reads the
 * files (docs/PACKDATA.md) instead of asking a running game. Client only: never loaded on a server.
 */
public final class NeiExport {

    /** A page that has to be asked item by item gets this long before it is cut short and reported as partial. */
    private static final long PER_ITEM_BUDGET_MS = 8 * 60 * 1000L;
    private static final int ALTERNATIVES_KEPT = 12;

    private final File dir;
    private final Map<String, JsonObject> items = new LinkedHashMap<>();
    private final Map<String, ItemStack> samples = new HashMap<>();
    private final JsonArray handlers = new JsonArray();
    private final Set<String> handlerKeys = new HashSet<>();
    private Writer recipes;
    private int recipeCount;
    private int structures;
    private int carving;

    private NeiExport(File dir) {
        this.dir = dir;
    }

    public static void run(File dir) throws Exception {
        new NeiExport(dir).all();
    }

    /**
     * Only the names, in the language this client runs in, of the items an earlier full run listed. Names of some
     * mods are fixed when the game starts, so a second language takes a second start; this is that second start.
     */
    public static void names(File dir) throws Exception {
        String lang = net.minecraft.client.Minecraft.getMinecraft()
            .getLanguageManager()
            .getCurrentLanguage()
            .getLanguageCode();
        File listed = new File(dir, "items.jsonl");
        int n = 0;
        try (java.io.BufferedReader in = new java.io.BufferedReader(
            new java.io.InputStreamReader(new java.io.FileInputStream(listed), StandardCharsets.UTF_8));
            Writer w = new BufferedWriter(
                new OutputStreamWriter(
                    new FileOutputStream(new File(dir, "names-" + lang + ".jsonl")),
                    StandardCharsets.UTF_8))) {
            JsonParser parser = new JsonParser();
            for (String line = in.readLine(); line != null; line = in.readLine()) {
                JsonObject o = parser.parse(line)
                    .getAsJsonObject();
                Item item = (Item) Item.itemRegistry.getObject(
                    o.get("id")
                        .getAsString());
                if (item == null) continue;
                int meta = o.get("meta")
                    .getAsInt();
                String name;
                try {
                    name = displayName(new ItemStack(item, 1, meta == OreDictionary.WILDCARD_VALUE ? 0 : meta));
                } catch (Throwable t) {
                    continue;
                }
                if (name.isEmpty()) continue;
                JsonObject out = new JsonObject();
                out.add("id", o.get("id"));
                out.add("meta", o.get("meta"));
                out.addProperty("name", name);
                w.write(out.toString());
                w.write('\n');
                n++;
            }
        }
        AiPlayerMod.LOG.info("export: {} names in {}", n, lang);
    }

    private void all() throws Exception {
        long t0 = System.currentTimeMillis();
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("cannot create " + dir);
        List<ItemStack> listed = new ArrayList<>(ItemList.items);
        for (ItemStack s : listed) note(s);
        AiPlayerMod.LOG.info("export: {} stacks in NEI's item list", listed.size());

        File tmp = new File(dir, "recipes.jsonl.part");
        recipes = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8), 1 << 16);
        List<ICraftingHandler> pages = new ArrayList<>(GuiCraftingRecipe.craftinghandlers);
        pages.addAll(GuiCraftingRecipe.serialCraftingHandlers);
        AiPlayerMod.LOG.info("export: {} recipe pages", pages.size());
        for (ICraftingHandler h : pages) {
            try {
                page(h, listed);
            } catch (Throwable t) {
                AiPlayerMod.LOG.warn("export: page " + h.getClass().getName() + " failed", t);
                JsonObject o = new JsonObject();
                o.addProperty("key", h.getClass().getName());
                o.addProperty("failed", String.valueOf(t));
                handlers.add(o);
            }
        }
        recipes.close();
        replace(tmp, new File(dir, "recipes.jsonl"));

        blocks();
        try {
            structures = StructureExport.run(dir);
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("export: the multiblock structures could not be written", t);
        }
        try {
            carving = CarvingExport.run(dir);
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("export: the carving groups could not be written", t);
        }
        try (Writer w = writer("items.jsonl.part")) {
            for (JsonObject o : items.values()) {
                w.write(o.toString());
                w.write('\n');
            }
        }
        replace(new File(dir, "items.jsonl.part"), new File(dir, "items.jsonl"));
        try (Writer w = writer("handlers.json.part")) {
            w.write(handlers.toString());
        }
        replace(new File(dir, "handlers.json.part"), new File(dir, "handlers.json"));
        meta(System.currentTimeMillis() - t0);
        AiPlayerMod.LOG.info(
            "export: done, {} items, {} recipes, {} pages in {} s",
            items.size(),
            recipeCount,
            handlers.size(),
            (System.currentTimeMillis() - t0) / 1000);
    }

    private Writer writer(String name) throws Exception {
        return new BufferedWriter(
            new OutputStreamWriter(new FileOutputStream(new File(dir, name)), StandardCharsets.UTF_8),
            1 << 16);
    }

    private static void replace(File from, File to) throws Exception {
        Files.move(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }

    private void meta(long ms) throws Exception {
        File f = new File(dir, "meta.json");
        JsonObject meta = new JsonObject();
        if (f.isFile()) {
            try {
                meta = new JsonParser().parse(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8))
                    .getAsJsonObject();
            } catch (Throwable ignored) {}
        }
        JsonObject o = new JsonObject();
        o.addProperty("format", 1);
        o.addProperty("generatedAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX").format(new java.util.Date()));
        o.addProperty(
            "lang",
            net.minecraft.client.Minecraft.getMinecraft()
                .getLanguageManager()
                .getCurrentLanguage()
                .getLanguageCode());
        o.addProperty("items", items.size());
        o.addProperty("recipes", recipeCount);
        o.addProperty("pages", handlers.size());
        o.addProperty("structures", structures);
        o.addProperty("carving", carving);
        o.addProperty("pack", packVersion());
        o.addProperty("seconds", ms / 1000);
        meta.add("nei", o);
        try (Writer w = writer("meta.json.part")) {
            w.write(meta.toString());
        }
        replace(new File(dir, "meta.json.part"), f);
    }

    /** The pack writes its version next to the game directory; the launcher's instance keeps it there. */
    private static String packVersion() {
        try {
            File f = new File(net.minecraft.client.Minecraft.getMinecraft().mcDataDir.getAbsoluteFile()
                .getParentFile(), ".gtnh-version");
            if (!f.isFile()) f = new File(net.minecraft.client.Minecraft.getMinecraft().mcDataDir, ".gtnh-version");
            if (f.isFile()) return "GTNH " + new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).trim();
        } catch (Throwable ignored) {}
        return "unknown";
    }

    // ---- items ----------------------------------------------------------------------------------------------

    private static String plain(String s) {
        if (s == null) return "";
        String t = EnumChatFormatting.getTextWithoutFormattingCodes(s);
        return (t == null ? s : t).replace('\n', ' ')
            .trim();
    }

    private static String id(Item item) {
        Object name = Item.itemRegistry.getNameForObject(item);
        return name == null ? null : name.toString();
    }

    private static String displayName(ItemStack s) {
        try {
            return plain(s.getDisplayName());
        } catch (Throwable t) {
            return "";
        }
    }

    /** One line per item and damage value; a stack that differs only by its tag counts as a variant of that line. */
    private JsonObject note(ItemStack s) {
        if (s == null || s.getItem() == null) return null;
        String id = id(s.getItem());
        if (id == null) return null;
        int meta = s.getItemDamage();
        String key = id + "/" + meta;
        JsonObject o = items.get(key);
        if (o != null) {
            if (s.hasTagCompound() && !displayName(s).equals(
                o.get("name")
                    .getAsString())) {
                o.addProperty("variants", o.has("variants") ? o.get("variants").getAsInt() + 1 : 1);
            }
            return o;
        }
        o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("meta", meta);
        ItemStack sample = s;
        String name = "";
        if (meta == OreDictionary.WILDCARD_VALUE) {
            try {
                sample = new ItemStack(s.getItem(), 1, 0);
            } catch (Throwable ignored) {}
        }
        name = displayName(sample);
        o.addProperty("name", name);
        try {
            int[] ores = meta == OreDictionary.WILDCARD_VALUE ? new int[0] : OreDictionary.getOreIDs(s);
            if (ores.length > 0) {
                JsonArray a = new JsonArray();
                for (int ore : ores) a.add(new JsonPrimitive(OreDictionary.getOreName(ore)));
                o.add("ores", a);
            }
        } catch (Throwable ignored) {}
        items.put(key, o);
        samples.put(key, sample);
        return o;
    }

    // ---- blocks ---------------------------------------------------------------------------------------------

    /**
     * The plain full cubes and the colour each shows, for anything that wants to pick blocks by colour. The colour
     * is the average of the texture file; blocks the game tints (grass, leaves) are left out because the file is
     * not what you see.
     */
    private void blocks() throws Exception {
        int n = 0;
        Map<String, int[]> colours = new HashMap<>();
        try (Writer w = writer("blocks.jsonl.part")) {
            for (Map.Entry<String, JsonObject> e : items.entrySet()) {
                ItemStack s = samples.get(e.getKey());
                if (s == null || !(s.getItem() instanceof net.minecraft.item.ItemBlock)) continue;
                int meta = s.getItemDamage();
                if (meta < 0 || meta > 15) continue;
                try {
                    net.minecraft.block.Block block = ((net.minecraft.item.ItemBlock) s.getItem()).field_150939_a;
                    if (block == null || !block.isOpaqueCube()
                        || !block.renderAsNormalBlock()
                        || block.hasTileEntity(meta)
                        || s.getItem()
                            .getMetadata(meta) != meta
                        || block.getRenderColor(meta) != 0xFFFFFF) continue;
                    net.minecraft.util.IIcon sideIcon = block.getIcon(2, meta), topIcon = block.getIcon(1, meta);
                    int[] side = colour(sideIcon, colours);
                    if (side == null) continue;
                    int[] top = colour(topIcon, colours);
                    JsonObject o = new JsonObject();
                    o.add(
                        "id",
                        e.getValue()
                            .get("id"));
                    o.addProperty("meta", meta);
                    o.add(
                        "name",
                        e.getValue()
                            .get("name"));
                    o.add("color", rgb(side));
                    if (top != null && (top[0] != side[0] || top[1] != side[1] || top[2] != side[2])) o.add("top", rgb(top));
                    // The texture files themselves, for whoever wants to draw the block rather than a colour.
                    o.addProperty("tex", sideIcon.getIconName());
                    if (top != null && !topIcon.getIconName()
                        .equals(sideIcon.getIconName())) o.addProperty("texTop", topIcon.getIconName());
                    if (block instanceof net.minecraft.block.BlockFalling) o.addProperty("falls", true);
                    if (block.getLightValue() > 0) o.addProperty("light", block.getLightValue());
                    w.write(o.toString());
                    w.write('\n');
                    n++;
                } catch (Throwable ignored) {}
            }
        }
        replace(new File(dir, "blocks.jsonl.part"), new File(dir, "blocks.jsonl"));
        AiPlayerMod.LOG.info("export: {} plain blocks with a colour", n);
    }

    private static JsonArray rgb(int[] c) {
        JsonArray a = new JsonArray();
        for (int v : c) a.add(new JsonPrimitive(v));
        return a;
    }

    private static int[] colour(net.minecraft.util.IIcon icon, Map<String, int[]> cache) {
        if (icon == null || icon.getIconName() == null) return null;
        String name = icon.getIconName();
        if (cache.containsKey(name)) return cache.get(name);
        int[] out = null;
        try {
            int colon = name.indexOf(':');
            net.minecraft.util.ResourceLocation at = new net.minecraft.util.ResourceLocation(
                colon < 0 ? "minecraft" : name.substring(0, colon),
                "textures/blocks/" + (colon < 0 ? name : name.substring(colon + 1)) + ".png");
            java.awt.image.BufferedImage img;
            try (java.io.InputStream in = net.minecraft.client.Minecraft.getMinecraft()
                .getResourceManager()
                .getResource(at)
                .getInputStream()) {
                img = javax.imageio.ImageIO.read(in);
            }
            // An animated texture is its frames stacked; the first square is enough.
            int size = Math.min(img.getWidth(), img.getHeight());
            long r = 0, g = 0, b = 0, count = 0;
            for (int y = 0; y < size; y++) for (int x = 0; x < size; x++) {
                int argb = img.getRGB(x, y);
                if ((argb >>> 24) < 128) continue;
                r += (argb >> 16) & 255;
                g += (argb >> 8) & 255;
                b += argb & 255;
                count++;
            }
            if (count >= (long) size * size / 2) out = new int[] { (int) (r / count), (int) (g / count), (int) (b / count) };
        } catch (Throwable ignored) {}
        cache.put(name, out);
        return out;
    }

    private JsonObject stack(ItemStack s) {
        JsonObject known = note(s);
        if (known == null) return null;
        JsonObject o = new JsonObject();
        o.add("id", known.get("id"));
        o.add("meta", known.get("meta"));
        o.addProperty("n", s.stackSize);
        if (s.hasTagCompound()) {
            String name = displayName(s);
            if (!name.isEmpty() && !name.equals(
                known.get("name")
                    .getAsString()))
                o.addProperty("name", name);
        }
        return o;
    }

    private static JsonObject fluid(FluidStack f) {
        JsonObject o = new JsonObject();
        o.addProperty(
            "f",
            f.getFluid()
                .getName());
        String name;
        try {
            name = plain(f.getLocalizedName());
        } catch (Throwable t) {
            name = f.getFluid()
                .getName();
        }
        o.addProperty("name", name);
        o.addProperty("mb", f.amount);
        return o;
    }

    /** The ore-dictionary name a set of interchangeable stacks stands for, when it is exactly one. */
    private static String oreOf(ItemStack[] options) {
        int[] first;
        try {
            first = OreDictionary.getOreIDs(options[0]);
        } catch (Throwable t) {
            return null;
        }
        String best = null;
        for (int ore : first) {
            String name = OreDictionary.getOreName(ore);
            List<ItemStack> members = OreDictionary.getOres(name);
            if (members.size() > options.length) continue;
            boolean all = true;
            for (ItemStack m : members) {
                boolean has = false;
                for (ItemStack o : options) {
                    if (o != null && o.getItem() == m.getItem()
                        && (m.getItemDamage() == OreDictionary.WILDCARD_VALUE || m.getItemDamage() == o.getItemDamage())) {
                        has = true;
                        break;
                    }
                }
                if (!has) {
                    all = false;
                    break;
                }
            }
            if (!all) continue;
            boolean covers = true;
            for (ItemStack o : options) {
                boolean in = false;
                for (ItemStack m : members) {
                    if (o != null && o.getItem() == m.getItem()
                        && (m.getItemDamage() == OreDictionary.WILDCARD_VALUE || m.getItemDamage() == o.getItemDamage())) {
                        in = true;
                        break;
                    }
                }
                if (!in) {
                    covers = false;
                    break;
                }
            }
            if (covers && (best == null || name.length() < best.length())) best = name;
        }
        return best;
    }

    private JsonObject slot(PositionedStack ps) {
        if (ps == null) return null;
        ItemStack[] options = ps.items;
        if (options == null || options.length == 0) options = new ItemStack[] { ps.item };
        if (options[0] == null) return null;
        if (options.length == 1) return stack(options[0]);
        JsonObject o = new JsonObject();
        o.addProperty("n", options[0].stackSize);
        String ore = oreOf(options);
        if (ore != null) o.addProperty("ore", ore);
        JsonArray any = new JsonArray();
        for (int i = 0; i < options.length && i < ALTERNATIVES_KEPT; i++) {
            JsonObject known = note(options[i]);
            if (known == null) continue;
            JsonArray pair = new JsonArray();
            pair.add(known.get("id"));
            pair.add(known.get("meta"));
            any.add(pair);
        }
        o.add("any", any);
        if (options.length > ALTERNATIVES_KEPT) o.addProperty("more", options.length - ALTERNATIVES_KEPT);
        return o;
    }

    // ---- pages ----------------------------------------------------------------------------------------------

    private void page(ICraftingHandler h, List<ItemStack> listed) throws Exception {
        long t0 = System.currentTimeMillis();
        String key = null;
        // GregTech has one class for all of its pages; what tells them apart is the recipe category they show.
        if (gregTechCache(h) != null) key = h.getOverlayIdentifier();
        if (key == null || key.isEmpty()) key = h.getHandlerId();
        if (key == null || key.isEmpty()) key = h.getClass()
            .getName();
        String base = key;
        for (int i = 2; !handlerKeys.add(key); i++) key = base + "#" + i;
        JsonObject info = new JsonObject();
        info.addProperty("key", key);
        info.addProperty("name", plain(h.getRecipeName()));
        info.addProperty(
            "class",
            h.getClass()
                .getName());
        try {
            HandlerInfo hi = GuiRecipeTab.getHandlerInfo(h);
            if (hi != null && hi.getModName() != null) info.addProperty("mod", hi.getModName());
        } catch (Throwable ignored) {}
        try {
            JsonArray machines = new JsonArray();
            List<PositionedStack> catalysts = RecipeCatalysts.getRecipeCatalysts(h);
            if (catalysts != null) for (PositionedStack ps : catalysts) {
                JsonObject m = ps == null || ps.item == null ? null : stack(ps.item);
                if (m != null) {
                    m.remove("n");
                    machines.add(m);
                }
            }
            if (machines.size() > 0) info.add("machines", machines);
        } catch (Throwable ignored) {}

        int before = recipeCount;
        String mode;
        List<?> gt = gregTechCache(h);
        if (gt != null) {
            mode = "gregtech";
            Field recipe = null;
            for (Object cached : gt) {
                if (recipe == null) recipe = cached.getClass()
                    .getField("mRecipe");
                JsonObject o = gregTech(recipe.get(cached));
                if (o != null) write(key, o);
            }
        } else {
            boolean grid = h instanceof ShapedRecipeHandler || h instanceof ShapelessRecipeHandler;
            if (grid) info.addProperty("grid", true);
            IRecipeHandler everything = everything(h);
            if (everything != null) {
                mode = "all";
                for (int i = 0; i < everything.numRecipes(); i++) {
                    JsonObject o = generic(everything, i, grid && h instanceof ShapedRecipeHandler);
                    if (o != null) write(key, o);
                }
            } else {
                mode = perItem(h, key, listed, grid && h instanceof ShapedRecipeHandler);
            }
        }
        info.addProperty("recipes", recipeCount - before);
        info.addProperty("read", mode);
        info.addProperty("ms", System.currentTimeMillis() - t0);
        handlers.add(info);
        AiPlayerMod.LOG.info(
            "export: {} \"{}\" {} recipes ({}, {} ms)",
            key,
            info.get("name")
                .getAsString(),
            recipeCount - before,
            mode,
            System.currentTimeMillis() - t0);
    }

    private void write(String key, JsonObject o) throws Exception {
        o.addProperty("h", key);
        recipes.write(o.toString());
        recipes.write('\n');
        recipeCount++;
    }

    /** GregTech's pages keep the recipe itself, which says more than its picture: power, time, chances, fluids. */
    private static List<?> gregTechCache(ICraftingHandler h) {
        try {
            Class<?> c = Class.forName("gregtech.nei.GTNEIDefaultHandler");
            if (!c.isInstance(h)) return null;
            return (List<?>) c.getMethod("getCache")
                .invoke(h);
        } catch (ClassNotFoundException e) {
            return null;
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("export: could not read a GregTech page directly", t);
            return null;
        }
    }

    private JsonObject gregTech(Object r) throws Exception {
        Class<?> c = r.getClass();
        if (!c.getField("mEnabled")
            .getBoolean(r)
            || c.getField("mHidden")
                .getBoolean(r))
            return null;
        JsonObject o = new JsonObject();
        JsonArray in = new JsonArray();
        ItemStack[] inputs = (ItemStack[]) c.getField("mInputs")
            .get(r);
        if (inputs != null) for (ItemStack s : inputs) {
            JsonObject j = s == null ? null : stack(s);
            if (j != null) in.add(j);
        }
        o.add("in", in);
        JsonArray out = new JsonArray();
        ItemStack[] outputs = (ItemStack[]) c.getField("mOutputs")
            .get(r);
        int[] chances = (int[]) c.getField("mOutputChances")
            .get(r);
        if (outputs != null) for (int i = 0; i < outputs.length; i++) {
            JsonObject j = outputs[i] == null ? null : stack(outputs[i]);
            if (j == null) continue;
            if (chances != null && i < chances.length && chances[i] < 10000) j.addProperty("chance", chances[i] / 10000.0);
            out.add(j);
        }
        o.add("out", out);
        FluidStack[] fin = (FluidStack[]) c.getField("mFluidInputs")
            .get(r);
        if (fin != null && fin.length > 0) {
            JsonArray a = new JsonArray();
            for (FluidStack f : fin) if (f != null && f.getFluid() != null) a.add(fluid(f));
            if (a.size() > 0) o.add("fin", a);
        }
        FluidStack[] fout = (FluidStack[]) c.getField("mFluidOutputs")
            .get(r);
        if (fout != null && fout.length > 0) {
            JsonArray a = new JsonArray();
            for (FluidStack f : fout) if (f != null && f.getFluid() != null) a.add(fluid(f));
            if (a.size() > 0) o.add("fout", a);
        }
        if (out.size() == 0 && !o.has("fout") && in.size() == 0 && !o.has("fin")) return null;
        o.addProperty(
            "eut",
            c.getField("mEUt")
                .getInt(r));
        o.addProperty(
            "ticks",
            c.getField("mDuration")
                .getInt(r));
        int special = c.getField("mSpecialValue")
            .getInt(r);
        if (special != 0) o.addProperty("special", special);
        if (c.getField("mFakeRecipe")
            .getBoolean(r)) o.addProperty("fake", true);
        return o;
    }

    /** The page with all of its recipes loaded, for the pages that can do that. */
    private static IRecipeHandler everything(ICraftingHandler h) {
        List<String> asks = new ArrayList<>();
        try {
            String overlay = h.getOverlayIdentifier();
            if (overlay != null) asks.add(overlay);
        } catch (Throwable ignored) {}
        if (h instanceof TemplateRecipeHandler) {
            try {
                Field rects = TemplateRecipeHandler.class.getField("transferRects");
                for (Object rect : (Iterable<?>) rects.get(h)) {
                    Field f = rect.getClass()
                        .getDeclaredField("outputId");
                    f.setAccessible(true);
                    Object id = f.get(rect);
                    if (id instanceof String && !asks.contains(id)) asks.add((String) id);
                }
            } catch (Throwable ignored) {}
        }
        IRecipeHandler best = null;
        for (String ask : asks) {
            try {
                IRecipeHandler loaded = h.getRecipeHandler(ask);
                if (loaded != null && loaded.numRecipes() > 0
                    && (best == null || loaded.numRecipes() > best.numRecipes())) best = loaded;
            } catch (Throwable ignored) {}
        }
        return best;
    }

    private String perItem(ICraftingHandler h, String key, List<ItemStack> listed, boolean shaped) throws Exception {
        long deadline = System.currentTimeMillis() + PER_ITEM_BUDGET_MS;
        Set<String> seen = new HashSet<>();
        int asked = 0, failed = 0;
        for (ItemStack s : listed) {
            if (System.currentTimeMillis() > deadline) return "per item, cut short after " + asked + " of " + listed.size();
            asked++;
            IRecipeHandler found;
            try {
                found = h.getRecipeHandler("item", s);
            } catch (Throwable t) {
                if (++failed > 200) return "per item, gave up after 200 errors: " + t;
                continue;
            }
            if (found == null) continue;
            int n;
            try {
                n = found.numRecipes();
            } catch (Throwable t) {
                continue;
            }
            for (int i = 0; i < n; i++) {
                JsonObject o;
                try {
                    o = generic(found, i, shaped);
                } catch (Throwable t) {
                    continue;
                }
                if (o != null && seen.add(o.toString())) write(key, o);
            }
        }
        return "per item";
    }

    private JsonObject generic(IRecipeHandler h, int i, boolean shaped) {
        JsonObject o = new JsonObject();
        JsonArray in = new JsonArray();
        List<PositionedStack> ingredients = h.getIngredientStacks(i);
        if (ingredients != null) for (PositionedStack ps : ingredients) {
            JsonObject j = slot(ps);
            if (j == null) continue;
            if (shaped) {
                // NEI draws the crafting grid from (25, 6) in steps of 18.
                int col = Math.round((ps.relx - 25) / 18f), row = Math.round((ps.rely - 6) / 18f);
                if (col >= 0 && col < 3 && row >= 0 && row < 3) j.addProperty("g", row * 3 + col);
            }
            in.add(j);
        }
        o.add("in", in);
        JsonArray out = new JsonArray();
        PositionedStack result = h.getResultStack(i);
        if (result != null) {
            JsonObject j = slot(result);
            if (j != null) out.add(j);
        }
        o.add("out", out);
        List<PositionedStack> others = h.getOtherStacks(i);
        if (others != null && !others.isEmpty()) {
            JsonArray a = new JsonArray();
            for (PositionedStack ps : others) {
                JsonObject j = slot(ps);
                if (j != null) a.add(j);
            }
            if (a.size() > 0) o.add("other", a);
        }
        if (in.size() == 0 && out.size() == 0 && !o.has("other")) return null;
        return o;
    }
}
