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
import codechicken.nei.util.ItemUntranslator;

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

    private NeiExport(File dir) {
        this.dir = dir;
    }

    public static void run(File dir) throws Exception {
        new NeiExport(dir).all();
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

        englishNames();
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
        o.addProperty("seconds", ms / 1000);
        meta.add("nei", o);
        try (Writer w = writer("meta.json.part")) {
            w.write(meta.toString());
        }
        replace(new File(dir, "meta.json.part"), f);
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

    private void englishNames() {
        ItemUntranslator english;
        try {
            english = ItemUntranslator.getInstance();
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("export: no English names, NEI's untranslator is not there", t);
            return;
        }
        int found = 0;
        for (Map.Entry<String, JsonObject> e : items.entrySet()) {
            try {
                String en = plain(english.getItemStackDisplayName(samples.get(e.getKey())));
                if (!en.isEmpty() && !en.equals(
                    e.getValue()
                        .get("name")
                        .getAsString())) {
                    e.getValue()
                        .addProperty("en", en);
                    found++;
                }
            } catch (Throwable ignored) {}
        }
        AiPlayerMod.LOG.info("export: {} items have an English name that differs", found);
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
        String key = h.getHandlerId();
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
        if (out.size() == 0 && !o.has("fout")) return null;
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
