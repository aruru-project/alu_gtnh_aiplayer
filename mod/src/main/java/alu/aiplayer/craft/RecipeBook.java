package alu.aiplayer.craft;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.crafting.CraftingManager;
import net.minecraft.item.crafting.FurnaceRecipes;
import net.minecraft.item.crafting.IRecipe;
import net.minecraft.util.StatCollector;
import net.minecraftforge.fluids.FluidStack;
import net.minecraftforge.oredict.OreDictionary;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.Names;

/**
 * What can be made and how: every crafting-table recipe, every GregTech machine recipe and every smelting recipe
 * the server knows, indexed by what they produce, with a name index over all the items involved.
 * <p>
 * The server holds all of this itself; no client is needed. The index is built once, on its own thread, after the
 * server has started, because by then mods have finished adding and removing recipes.
 */
public final class RecipeBook {

    /** One kind of item: an item and its metadata. */
    public static final class Entry {

        public final ItemStack stack;
        public final String id;
        public final int meta;
        public String name;
        String lower;
        String idLower;
        public final List<IRecipe> crafting = new ArrayList<>(1);
        public final List<Machine> machine = new ArrayList<>(1);
        public final List<ItemStack> smeltedFrom = new ArrayList<>(1);
        public final List<String> ores = new ArrayList<>(1);

        Entry(ItemStack stack) {
            this.stack = stack;
            this.id = Names.itemId(stack.getItem());
            this.meta = stack.getItemDamage();
        }

        public JsonObject json() {
            JsonObject o = new JsonObject();
            o.addProperty("id", id);
            o.addProperty("meta", meta);
            o.addProperty("name", name);
            return o;
        }
    }

    /** One recipe of a GregTech machine. */
    public static final class Machine {

        public final String machine;
        public final ItemStack[] in, out;
        public final FluidStack[] fluidIn, fluidOut;
        public final int eut, ticks;

        Machine(String machine, ItemStack[] in, ItemStack[] out, FluidStack[] fluidIn, FluidStack[] fluidOut, int eut,
            int ticks) {
            this.machine = machine;
            this.in = in;
            this.out = out;
            this.fluidIn = fluidIn;
            this.fluidOut = fluidOut;
            this.eut = eut;
            this.ticks = ticks;
        }
    }

    private static volatile RecipeBook ready;
    private static volatile boolean building;
    private static volatile String failure;

    private final Map<Long, Entry> entries = new HashMap<>();
    private final List<Entry> all = new ArrayList<>();
    private final Map<Object, String> oreOfList = new IdentityHashMap<>();
    private int craftingCount, machineCount, smeltingCount;

    /** Starts building the index unless that has been done or is under way. */
    public static synchronized void buildInBackground() {
        if (ready != null || building) return;
        building = true;
        failure = null;
        Thread t = new Thread(() -> {
            long start = System.currentTimeMillis();
            try {
                RecipeBook book = new RecipeBook();
                book.build();
                ready = book;
                AiPlayerMod.LOG.info(
                    "Recipe index ready in {} ms: {} kinds of item, {} crafting, {} machine and {} smelting recipes",
                    System.currentTimeMillis() - start,
                    book.all.size(),
                    book.craftingCount,
                    book.machineCount,
                    book.smeltingCount);
            } catch (Throwable e) {
                failure = String.valueOf(e);
                AiPlayerMod.LOG.error("Building the recipe index failed", e);
            } finally {
                building = false;
            }
        }, "aiplayer-recipes");
        t.setDaemon(true);
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
    }

    /** Forgets the index; the next server start builds a fresh one. */
    public static synchronized void reset() {
        ready = null;
    }

    public static boolean isReady() {
        return ready != null;
    }

    /** The index, or an error telling the caller to come back shortly while it is still being built. */
    public static RecipeBook get() {
        RecipeBook book = ready;
        if (book != null) return book;
        if (failure != null) throw new IllegalStateException("the recipe index could not be built: " + failure);
        buildInBackground();
        throw new RpcException("busy", "the recipe index is still being built; try again in a few seconds");
    }

    private static long key(Item item, int meta) {
        return ((long) Item.getIdFromItem(item) << 16) | (meta & 0xFFFFL);
    }

    public Entry entry(String id, int meta) {
        Item item = Names.item(id);
        return item == null ? null : entries.get(key(item, meta));
    }

    public Entry entry(ItemStack stack) {
        return stack == null || stack.getItem() == null ? null : entries.get(key(stack.getItem(), stack.getItemDamage()));
    }

    private Entry note(ItemStack stack) {
        if (stack == null || stack.getItem() == null) return null;
        int meta = stack.getItemDamage();
        if (meta == OreDictionary.WILDCARD_VALUE) return null;
        long k = key(stack.getItem(), meta);
        Entry e = entries.get(k);
        if (e == null) {
            ItemStack one = stack.copy();
            one.stackSize = 1;
            e = new Entry(one);
            entries.put(k, e);
            all.add(e);
        }
        return e;
    }

    // ---- building -------------------------------------------------------------------------------------------

    private void build() {
        for (String ore : OreDictionary.getOreNames()) {
            List<ItemStack> list = OreDictionary.getOres(ore);
            oreOfList.put(list, ore);
            for (ItemStack s : new ArrayList<>(list)) {
                Entry e = note(s);
                if (e != null && e.ores.size() < 4) e.ores.add(ore);
            }
        }
        for (Object o : new ArrayList<Object>(
            CraftingManager.getInstance()
                .getRecipeList())) {
            if (!(o instanceof IRecipe)) continue;
            IRecipe r = (IRecipe) o;
            ItemStack out;
            try {
                out = r.getRecipeOutput();
            } catch (Throwable t) {
                continue;
            }
            Entry e = note(out);
            if (e == null) continue;
            e.crafting.add(r);
            craftingCount++;
        }
        for (Object o : FurnaceRecipes.smelting()
            .getSmeltingList()
            .entrySet()) {
            Map.Entry<?, ?> pair = (Map.Entry<?, ?>) o;
            if (!(pair.getKey() instanceof ItemStack) || !(pair.getValue() instanceof ItemStack)) continue;
            Entry e = note((ItemStack) pair.getValue());
            if (e == null) continue;
            e.smeltedFrom.add((ItemStack) pair.getKey());
            note((ItemStack) pair.getKey());
            smeltingCount++;
        }
        readGregTech();
        for (Entry e : all) {
            String name;
            try {
                name = e.stack.getDisplayName();
            } catch (Throwable t) {
                name = e.id;
            }
            e.name = name == null ? e.id : name;
            e.lower = e.name.toLowerCase(Locale.ROOT);
            e.idLower = e.id.toLowerCase(Locale.ROOT);
        }
    }

    /** GregTech is read by reflection so that this mod builds and runs without it. */
    private void readGregTech() {
        try {
            Class<?> mapClass = Class.forName("gregtech.api.recipe.RecipeMap");
            Class<?> recipeClass = Class.forName("gregtech.api.util.GTRecipe");
            Map<?, ?> maps = (Map<?, ?>) mapClass.getField("ALL_RECIPE_MAPS")
                .get(null);
            Method getAll = mapClass.getMethod("getAllRecipes");
            Field unlocalized = mapClass.getField("unlocalizedName");
            Field in = recipeClass.getField("mInputs"), out = recipeClass.getField("mOutputs");
            Field fin = recipeClass.getField("mFluidInputs"), fout = recipeClass.getField("mFluidOutputs");
            Field eut = recipeClass.getField("mEUt"), dur = recipeClass.getField("mDuration");
            Field enabled = recipeClass.getField("mEnabled"), hidden = recipeClass.getField("mHidden");
            for (Object map : new ArrayList<Object>(maps.values())) {
                String raw = (String) unlocalized.get(map);
                String name = StatCollector.translateToLocal(raw);
                if (name == null || name.isEmpty() || name.equals(raw)) name = raw;
                Collection<?> recipes = (Collection<?>) getAll.invoke(map);
                for (Object r : new ArrayList<Object>(recipes)) {
                    if (!enabled.getBoolean(r) || hidden.getBoolean(r)) continue;
                    ItemStack[] outputs = (ItemStack[]) out.get(r);
                    if (outputs == null || outputs.length == 0) continue;
                    Machine m = new Machine(
                        name,
                        (ItemStack[]) in.get(r),
                        outputs,
                        (FluidStack[]) fin.get(r),
                        (FluidStack[]) fout.get(r),
                        eut.getInt(r),
                        dur.getInt(r));
                    boolean counted = false;
                    for (ItemStack s : outputs) {
                        Entry e = note(s);
                        if (e == null || e.machine.contains(m)) continue;
                        e.machine.add(m);
                        counted = true;
                    }
                    if (counted) machineCount++;
                    if (m.in != null) for (ItemStack s : m.in) note(s);
                }
            }
        } catch (ClassNotFoundException e) {
            // No GregTech here.
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("GregTech recipes could not be read; machine recipes are left out", t);
        }
    }

    // ---- looking things up ----------------------------------------------------------------------------------

    /** Items whose name or id contains every word of the query, best match first. */
    public List<Entry> search(String query, int limit) {
        String q = query.trim()
            .toLowerCase(Locale.ROOT);
        final String[] words = q.split("\\s+");
        List<Entry> hits = new ArrayList<>();
        final Map<Entry, Integer> score = new IdentityHashMap<>();
        for (Entry e : all) {
            boolean ok = true;
            for (String w : words) {
                if (!e.lower.contains(w) && !e.idLower.contains(w)) {
                    ok = false;
                    break;
                }
            }
            if (!ok) continue;
            int s = e.lower.equals(q) ? 0 : (e.lower.startsWith(q) ? 1000 : 2000) + e.lower.length();
            // Something that can be made is more likely what is meant than a variant nothing produces.
            if (e.crafting.isEmpty() && e.machine.isEmpty() && e.smeltedFrom.isEmpty()) s += 500;
            score.put(e, s);
            hits.add(e);
        }
        Collections.sort(hits, (a, b) -> score.get(a) - score.get(b));
        return hits.size() > limit ? new ArrayList<>(hits.subList(0, limit)) : hits;
    }

    public JsonObject searchJson(String query, int limit) {
        List<Entry> hits = search(query, limit);
        JsonArray items = new JsonArray();
        for (Entry e : hits) {
            JsonObject o = e.json();
            JsonObject n = new JsonObject();
            n.addProperty("crafting", e.crafting.size());
            n.addProperty("machine", e.machine.size());
            n.addProperty("smelting", e.smeltedFrom.size());
            o.add("recipes", n);
            if (!e.ores.isEmpty()) {
                JsonArray ores = new JsonArray();
                for (String s : e.ores) ores.add(new com.google.gson.JsonPrimitive(s));
                o.add("ores", ores);
            }
            items.add(o);
        }
        JsonObject o = new JsonObject();
        o.add("items", items);
        return o;
    }

    private static final String[] TIERS = { "ULV", "LV", "MV", "HV", "EV", "IV", "LuV", "ZPM", "UV", "UHV" };

    /** The lowest machine tier whose voltage covers a recipe. */
    public static String tier(int eut) {
        long v = 8;
        for (String t : TIERS) {
            if (Math.abs((long) eut) <= v) return t;
            v *= 4;
        }
        return "UEV+";
    }

    private JsonObject stackJson(ItemStack s) {
        JsonObject o = new JsonObject();
        o.addProperty("id", Names.itemId(s.getItem()));
        o.addProperty("meta", s.getItemDamage());
        o.addProperty("name", Names.displayName(s));
        o.addProperty("count", s.stackSize);
        return o;
    }

    private static JsonObject fluidJson(FluidStack f) {
        JsonObject o = new JsonObject();
        String name;
        try {
            name = f.getLocalizedName();
        } catch (Throwable t) {
            name = f.getFluid() == null ? "?" : f.getFluid()
                .getName();
        }
        o.addProperty("name", name);
        o.addProperty("mb", f.amount);
        return o;
    }

    /**
     * How an item is made.
     *
     * @param p        whose inventory to count the crafting ingredients against; may be null
     * @param machine_ only machine recipes of machines whose name contains this; null for a few of each
     */
    public JsonObject recipesJson(Entry e, EntityPlayerMP p, int craftingLimit, int machineLimit, String machine_) {
        final String machineFilter = machine_ == null || machine_.trim()
            .isEmpty() ? null
                : machine_.trim()
                    .toLowerCase(Locale.ROOT);
        JsonObject o = new JsonObject();
        o.add("item", e.json());
        JsonArray crafting = new JsonArray();
        for (int i = 0; i < e.crafting.size() && crafting.size() < craftingLimit; i++) {
            Layout l = Layout.of(e.crafting.get(i), this);
            JsonObject r = new JsonObject();
            r.addProperty("index", i);
            ItemStack out = e.crafting.get(i)
                .getRecipeOutput();
            r.addProperty("gives", out == null ? 1 : out.stackSize);
            if (l == null) {
                // A recipe of some mod's own kind: the game can match it, but its ingredients cannot be read here.
                r.addProperty("unreadable", true);
            } else {
                r.addProperty("grid", l.needsTable() ? "3x3" : "2x2");
                r.add("ingredients", l.ingredientsJson(p));
            }
            crafting.add(r);
        }
        o.add("crafting", crafting);

        List<Machine> machines = new ArrayList<>(e.machine);
        Collections.sort(machines, (a, b) -> a.eut != b.eut ? Integer.compare(a.eut, b.eut) : Integer.compare(a.ticks, b.ticks));
        JsonArray machine = new JsonArray();
        // A few recipes of each machine rather than many of one: the caller wants to know its options.
        Map<String, Integer> perMachine = new java.util.LinkedHashMap<>();
        for (Machine m : machines) perMachine.merge(m.machine, 1, Integer::sum);
        Map<String, Integer> shown = new HashMap<>();
        for (Machine m : machines) {
            if (machine.size() >= machineLimit) break;
            if (machineFilter != null && !m.machine.toLowerCase(Locale.ROOT)
                .contains(machineFilter)) continue;
            if (machineFilter == null && shown.merge(m.machine, 1, Integer::sum) > 2) continue;
            JsonObject r = new JsonObject();
            r.addProperty("machine", m.machine);
            r.addProperty("tier", tier(m.eut));
            r.addProperty("eut", m.eut);
            r.addProperty("seconds", Math.round(m.ticks / 2.0) / 10.0);
            JsonArray in = new JsonArray();
            if (m.in != null) for (ItemStack s : m.in) {
                if (s == null || s.getItem() == null) continue;
                JsonObject j = stackJson(s);
                // Count 0 marks something that must be in the machine but is not used up, such as a circuit.
                if (s.stackSize == 0) j.addProperty("notConsumed", true);
                in.add(j);
            }
            r.add("inputs", in);
            if (m.fluidIn != null && m.fluidIn.length > 0) {
                JsonArray f = new JsonArray();
                for (FluidStack s : m.fluidIn) if (s != null) f.add(fluidJson(s));
                if (f.size() > 0) r.add("fluidInputs", f);
            }
            JsonArray out = new JsonArray();
            for (ItemStack s : m.out) if (s != null && s.getItem() != null) out.add(stackJson(s));
            r.add("outputs", out);
            if (m.fluidOut != null && m.fluidOut.length > 0) {
                JsonArray f = new JsonArray();
                for (FluidStack s : m.fluidOut) if (s != null) f.add(fluidJson(s));
                if (f.size() > 0) r.add("fluidOutputs", f);
            }
            machine.add(r);
        }
        o.add("machines", machine);
        if (!perMachine.isEmpty()) {
            JsonObject by = new JsonObject();
            for (Map.Entry<String, Integer> pm : perMachine.entrySet()) by.addProperty(pm.getKey(), pm.getValue());
            o.add("machineRecipeCounts", by);
        }

        JsonArray smelting = new JsonArray();
        for (ItemStack s : e.smeltedFrom) if (smelting.size() < 6) smelting.add(stackJson(s));
        if (smelting.size() > 0) o.add("smeltedFrom", smelting);

        JsonObject total = new JsonObject();
        total.addProperty("crafting", e.crafting.size());
        total.addProperty("machines", e.machine.size());
        total.addProperty("smelting", e.smeltedFrom.size());
        o.add("total", total);
        return o;
    }

    /** The ore-dictionary name a recipe's list of alternatives stands for, or null. */
    String oreName(Object list) {
        return oreOfList.get(list);
    }
}
