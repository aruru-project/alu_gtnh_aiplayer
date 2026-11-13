package alu.aiplayer.craft;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.item.crafting.IRecipe;
import net.minecraft.item.crafting.ShapedRecipes;
import net.minecraft.item.crafting.ShapelessRecipes;
import net.minecraftforge.oredict.OreDictionary;
import net.minecraftforge.oredict.ShapedOreRecipe;
import net.minecraftforge.oredict.ShapelessOreRecipe;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.util.Names;

/**
 * A crafting recipe as it is laid on the grid: which cell takes what. A cell is empty, one particular item, or
 * any one of a list of alternatives (an ore-dictionary entry such as "any steel plate").
 */
public final class Layout {

    public final int width, height;
    /** Row by row, {@code width} to a row; null for an empty cell, else an ItemStack or a List of them. */
    public final Object[] cells;
    private final RecipeBook book;

    private Layout(int width, int height, Object[] cells, RecipeBook book) {
        this.width = width;
        this.height = height;
        this.cells = cells;
        this.book = book;
    }

    private static Field oreWidth, oreHeight;

    /** The layout of a recipe, or null for kinds of recipe whose ingredients cannot be read. */
    public static Layout of(IRecipe r, RecipeBook book) {
        try {
            if (r instanceof ShapedRecipes) {
                ShapedRecipes s = (ShapedRecipes) r;
                return new Layout(s.recipeWidth, s.recipeHeight, s.recipeItems.clone(), book);
            }
            if (r instanceof ShapedOreRecipe) {
                if (oreWidth == null) {
                    oreWidth = ShapedOreRecipe.class.getDeclaredField("width");
                    oreHeight = ShapedOreRecipe.class.getDeclaredField("height");
                    oreWidth.setAccessible(true);
                    oreHeight.setAccessible(true);
                }
                Object[] in = ((ShapedOreRecipe) r).getInput();
                int w = oreWidth.getInt(r), h = oreHeight.getInt(r);
                if (w <= 0 || h <= 0 || w * h != in.length) return null;
                return checked(new Layout(w, h, in.clone(), book));
            }
            List<?> loose = null;
            if (r instanceof ShapelessRecipes) loose = ((ShapelessRecipes) r).recipeItems;
            else if (r instanceof ShapelessOreRecipe) loose = ((ShapelessOreRecipe) r).getInput();
            if (loose != null) {
                int n = loose.size();
                if (n == 0 || n > 9) return null;
                int w = n <= 4 ? Math.min(n, 2) : 3;
                int h = (n + w - 1) / w;
                Object[] cells = new Object[w * h];
                for (int i = 0; i < n; i++) cells[i] = loose.get(i);
                return checked(new Layout(w, h, cells, book));
            }
        } catch (Throwable t) {
            return null;
        }
        return null;
    }

    /**
     * A layout somebody spells out cell by cell: nine cells of a three-by-three grid, row by row, each null, an
     * item ({id, meta?}) or an ore-dictionary name ({ore}). Empty rows below it and empty columns to its right are
     * dropped, so a recipe that fits two by two can be made without a table. Empty rows above it and columns to
     * its left stay: where a shape begins is part of some recipes. The pack's clay casts are all "a blank cast and
     * a knife", and which cast comes out is decided by the cells the two sit in.
     *
     * @throws IllegalArgumentException when a cell names nothing that exists
     */
    public static Layout fromGrid(com.google.gson.JsonArray grid, RecipeBook book) {
        if (grid.size() != 9) throw new IllegalArgumentException("grid must have 9 cells, row by row");
        Object[] all = new Object[9];
        int maxX = -1, maxY = -1;
        for (int i = 0; i < 9; i++) {
            com.google.gson.JsonElement e = grid.get(i);
            if (e == null || e.isJsonNull()) continue;
            JsonObject o = e.getAsJsonObject();
            if (o.has("ore")) {
                String ore = o.get("ore")
                    .getAsString();
                List<ItemStack> any = OreDictionary.getOres(ore);
                if (any == null || any.isEmpty()) throw new IllegalArgumentException("nothing is registered as " + ore);
                all[i] = any;
            } else {
                String id = o.get("id")
                    .getAsString();
                net.minecraft.item.Item item = Names.item(id);
                if (item == null) throw new IllegalArgumentException("unknown item id: " + id);
                int meta = o.has("meta") ? o.get("meta")
                    .getAsInt() : OreDictionary.WILDCARD_VALUE;
                all[i] = new ItemStack(item, 1, meta);
            }
            maxX = Math.max(maxX, i % 3);
            maxY = Math.max(maxY, i / 3);
        }
        if (maxX < 0) throw new IllegalArgumentException("the grid is empty");
        int w = maxX + 1, h = maxY + 1;
        Object[] cells = new Object[w * h];
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) cells[y * w + x] = all[y * 3 + x];
        return new Layout(w, h, cells, book);
    }

    private static Layout checked(Layout l) {
        for (Object c : l.cells) {
            if (c != null && !(c instanceof ItemStack) && !(c instanceof List)) return null;
            // An ore name nothing is registered under: the recipe cannot be made at all.
            if (c instanceof List && ((List<?>) c).isEmpty()) return null;
        }
        return l;
    }

    /** Whether the recipe is too big for the two-by-two grid a player carries. */
    public boolean needsTable() {
        return width > 2 || height > 2;
    }

    public static boolean matches(Object cell, ItemStack stack) {
        if (stack == null) return false;
        if (cell instanceof ItemStack) return OreDictionary.itemMatches((ItemStack) cell, stack, false);
        if (cell instanceof List) {
            for (Object o : (List<?>) cell) {
                if (o instanceof ItemStack && OreDictionary.itemMatches((ItemStack) o, stack, false)) return true;
            }
        }
        return false;
    }

    /** The ore-dictionary name behind a cell's alternatives, or null. */
    public String ore(Object cell) {
        return cell instanceof List ? book.oreName(cell) : null;
    }

    /** A display hint from ore registration, not a promise of reuse or enough durability for a batch. */
    public boolean isTool(Object cell) {
        String ore = ore(cell);
        if (ore != null) return ore.startsWith("craftingTool");
        if (!(cell instanceof ItemStack)) return false;
        ItemStack s = (ItemStack) cell;
        if (s.getItem() == null) return false;
        ItemStack probe = s.getItemDamage() == OreDictionary.WILDCARD_VALUE ? new ItemStack(s.getItem(), 1, 0) : s.copy();
        try {
            for (int id : OreDictionary.getOreIDs(probe)) {
                if (OreDictionary.getOreName(id)
                    .startsWith("craftingTool")) return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }

    public String label(Object cell) {
        if (cell instanceof ItemStack) {
            ItemStack s = (ItemStack) cell;
            if (s.getItemDamage() != OreDictionary.WILDCARD_VALUE) return Names.displayName(s);
            return Names.displayName(new ItemStack(s.getItem(), 1, 0)) + " (any variant)";
        }
        List<?> list = (List<?>) cell;
        String first = list.isEmpty() ? "?" : label(list.get(0));
        String ore = ore(cell);
        return ore == null ? first + (list.size() > 1 ? " or similar" : "") : first + " (any " + ore + ")";
    }

    /** The distinct things the recipe takes, each with how many cells want it. */
    public List<Object> distinct() {
        List<Object> out = new ArrayList<>();
        for (Object c : cells) {
            if (c == null) continue;
            boolean seen = false;
            for (Object o : out) {
                if (same(o, c)) {
                    seen = true;
                    break;
                }
            }
            if (!seen) out.add(c);
        }
        return out;
    }

    public static boolean same(Object a, Object b) {
        if (a == b) return true;
        if (a instanceof ItemStack && b instanceof ItemStack) {
            ItemStack x = (ItemStack) a, y = (ItemStack) b;
            return x.getItem() == y.getItem() && x.getItemDamage() == y.getItemDamage()
                && ItemStack.areItemStackTagsEqual(x, y);
        }
        return false;
    }

    public int cellsWanting(Object kind) {
        int n = 0;
        for (Object c : cells) if (c != null && same(c, kind)) n++;
        return n;
    }

    public static int carried(EntityPlayerMP p, Object cell) {
        int n = 0;
        for (ItemStack s : p.inventory.mainInventory) if (matches(cell, s)) n += s.stackSize;
        return n;
    }

    /** Does an actual carried alternative declare a crafting remainder? Never invoke getContainerItem here. */
    public static boolean carriedReturnsItem(EntityPlayerMP p, Object cell) {
        for (ItemStack s : p.inventory.mainInventory) {
            if (!matches(cell, s)) continue;
            // Some mods update a stack while checking usability, so even this query gets a copy.
            ItemStack probe = s.copy();
            if (probe.getItem().hasContainerItem(probe)) return true;
        }
        return false;
    }

    public JsonObject ingredientJson(Object cell, int count) {
        JsonObject o = new JsonObject();
        o.addProperty("count", count);
        o.addProperty("name", label(cell));
        if (cell instanceof ItemStack) {
            ItemStack s = (ItemStack) cell;
            o.addProperty("id", Names.itemId(s.getItem()));
            if (s.getItemDamage() != OreDictionary.WILDCARD_VALUE) o.addProperty("meta", s.getItemDamage());
        } else {
            String ore = ore(cell);
            if (ore != null) o.addProperty("ore", ore);
            // One concrete item that fits, so the ingredient can be looked up or searched for in storage.
            List<?> list = (List<?>) cell;
            for (Object x : list) {
                if (!(x instanceof ItemStack)) continue;
                ItemStack s = (ItemStack) x;
                JsonObject eg = new JsonObject();
                eg.addProperty("id", Names.itemId(s.getItem()));
                if (s.getItemDamage() != OreDictionary.WILDCARD_VALUE) eg.addProperty("meta", s.getItemDamage());
                o.add("example", eg);
                break;
            }
            if (list.size() > 1) o.addProperty("alternatives", list.size());
        }
        if (isTool(cell)) o.addProperty("tool", true);
        return o;
    }

    public JsonArray ingredientsJson(EntityPlayerMP p) {
        JsonArray out = new JsonArray();
        for (Object kind : distinct()) {
            JsonObject o = ingredientJson(kind, cellsWanting(kind));
            if (p != null) {
                o.addProperty("have", carried(p, kind));
                if (carriedReturnsItem(p, kind)) o.addProperty("containerItem", true);
            }
            out.add(o);
        }
        return out;
    }
}
