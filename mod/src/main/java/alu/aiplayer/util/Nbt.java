package alu.aiplayer.util;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTBase;
import net.minecraft.nbt.NBTTagByteArray;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.nbt.NBTTagIntArray;
import net.minecraft.nbt.NBTTagList;
import net.minecraft.nbt.NBTTagString;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * A block's own saved data, as JSON. Every block that keeps anything (what is in it, how it is set, what it is
 * doing) writes it all into one tree when the world is saved; this is that tree, readable, so that nothing has to
 * be known about a kind of block to see what it knows about itself.
 */
public final class Nbt {

    private Nbt() {}

    /** How much of a tree is written out: how deep, how many entries of a list, how many characters in all. */
    public static final class Limits {

        public int depth = 6;
        public int list = 40;
        public int chars = 40_000;
        int used;
        public boolean cut;
    }

    /** The part of a tree at a path such as {@code Items[3].tag} or {@code gt.covers}; null when there is none. */
    public static NBTBase at(NBTBase root, String path) {
        if (path == null || path.trim()
            .isEmpty()) return root;
        NBTBase here = root;
        String rest = path.trim();
        while (!rest.isEmpty() && here != null) {
            if (rest.startsWith("[")) {
                int end = rest.indexOf(']');
                if (end < 0 || !(here instanceof NBTTagList)) return null;
                int i;
                try {
                    i = Integer.parseInt(rest.substring(1, end));
                } catch (NumberFormatException e) {
                    return null;
                }
                NBTTagList list = (NBTTagList) here;
                if (i < 0 || i >= list.tagCount()) return null;
                here = element(list, i);
                rest = rest.substring(end + 1);
                if (rest.startsWith(".")) rest = rest.substring(1);
                continue;
            }
            if (!(here instanceof NBTTagCompound)) return null;
            NBTTagCompound c = (NBTTagCompound) here;
            // Keys may hold dots themselves ("gt.covers"): the longest key that fits wins.
            String key = null;
            for (Object k : c.func_150296_c()) {
                String name = (String) k;
                if ((rest.equals(name) || rest.startsWith(name + ".") || rest.startsWith(name + "["))
                    && (key == null || name.length() > key.length())) key = name;
            }
            if (key == null) return null;
            here = c.getTag(key);
            rest = rest.substring(key.length());
            if (rest.startsWith(".")) rest = rest.substring(1);
        }
        return here;
    }

    private static NBTBase element(NBTTagList list, int i) {
        // The list hands out its elements only by type; a copy taken apart gives them whatever they are.
        NBTTagList copy = (NBTTagList) list.copy();
        NBTBase out = null;
        for (int n = 0; n <= i && copy.tagCount() > 0; n++) out = copy.removeTag(0);
        return out;
    }

    public static JsonElement json(NBTBase tag, Limits limits) {
        return json(tag, limits, 0);
    }

    private static JsonElement json(NBTBase tag, Limits l, int depth) {
        if (tag == null) return new JsonPrimitive("(nothing)");
        if (tag instanceof NBTTagCompound) {
            NBTTagCompound c = (NBTTagCompound) tag;
            JsonObject o = new JsonObject();
            // An item stack is saved under a number that means nothing outside this server: say which item it is.
            ItemStack stack = asStack(c);
            if (stack != null) {
                o.addProperty("item", String.valueOf(Item.itemRegistry.getNameForObject(stack.getItem())));
                o.addProperty("meta", stack.getItemDamage());
                o.addProperty("count", stack.stackSize);
                try {
                    o.addProperty("name", Names.displayName(stack));
                } catch (Throwable ignored) {}
                l.used += 80;
            }
            if (depth >= l.depth) {
                o.addProperty("…", c.func_150296_c().size() + " key(s) not shown this deep: ask for this path");
                l.cut = true;
                return o;
            }
            for (Object k : new java.util.TreeSet<Object>(c.func_150296_c())) {
                String key = (String) k;
                if (stack != null && (key.equals("id") || key.equals("Count") || key.equals("Damage"))) continue;
                if (l.used > l.chars) {
                    o.addProperty("…", "the rest is cut off (too long): ask for a path inside it");
                    l.cut = true;
                    break;
                }
                l.used += key.length() + 4;
                o.add(key, json(c.getTag(key), l, depth + 1));
            }
            return o;
        }
        if (tag instanceof NBTTagList) {
            NBTTagList list = (NBTTagList) ((NBTTagList) tag).copy();
            JsonArray a = new JsonArray();
            int total = list.tagCount();
            if (depth >= l.depth && total > 0) {
                a.add(new JsonPrimitive(total + " entr(ies) not shown this deep: ask for this path"));
                l.cut = true;
                return a;
            }
            int shown = 0;
            while (list.tagCount() > 0) {
                NBTBase e = list.removeTag(0);
                if (shown >= l.list || l.used > l.chars) {
                    a.add(new JsonPrimitive("… " + (total - shown) + " more entr(ies): ask for [" + shown + "] and on"));
                    l.cut = true;
                    break;
                }
                a.add(json(e, l, depth + 1));
                shown++;
            }
            return a;
        }
        if (tag instanceof NBTTagString) {
            String s = ((NBTTagString) tag).func_150285_a_();
            l.used += Math.min(s.length(), 2000) + 2;
            return new JsonPrimitive(s.length() > 2000 ? s.substring(0, 2000) + "… (" + s.length() + " characters)" : s);
        }
        if (tag instanceof NBTTagByteArray) {
            byte[] b = ((NBTTagByteArray) tag).func_150292_c();
            l.used += 20;
            return new JsonPrimitive("(" + b.length + " bytes)");
        }
        if (tag instanceof NBTTagIntArray) {
            int[] v = ((NBTTagIntArray) tag).func_150302_c();
            if (v.length > 32) {
                l.used += 20;
                return new JsonPrimitive("(" + v.length + " numbers)");
            }
            JsonArray a = new JsonArray();
            for (int x : v) a.add(new JsonPrimitive(x));
            l.used += v.length * 6;
            return a;
        }
        if (tag instanceof NBTBase.NBTPrimitive) {
            NBTBase.NBTPrimitive p = (NBTBase.NBTPrimitive) tag;
            l.used += 8;
            byte id = tag.getId();
            if (id == 5 || id == 6) return new JsonPrimitive(p.func_150286_g());
            return new JsonPrimitive(p.func_150291_c());
        }
        l.used += 10;
        return new JsonPrimitive(tag.toString());
    }

    /**
     * Every value of a tree under its path ({@code mFacing}, {@code gt.covers[2].data}), as text: to tell what changed
     * between two moments. Arrays too long to write out are written as their length and a hash, so that a change shows.
     */
    public static java.util.Map<String, String> flatten(NBTBase root) {
        java.util.Map<String, String> out = new java.util.LinkedHashMap<>();
        flatten(root, "", out, 0);
        return out;
    }

    private static void flatten(NBTBase tag, String path, java.util.Map<String, String> out, int depth) {
        if (tag == null || out.size() >= 4000) return;
        if (tag instanceof NBTTagCompound) {
            NBTTagCompound c = (NBTTagCompound) tag;
            if (depth >= 10) {
                out.put(path, "(" + c.func_150296_c().size() + " keys, " + c.hashCode() + ")");
                return;
            }
            for (Object k : new java.util.TreeSet<Object>(c.func_150296_c())) {
                String key = (String) k;
                flatten(c.getTag(key), path.isEmpty() ? key : path + "." + key, out, depth + 1);
            }
            return;
        }
        if (tag instanceof NBTTagList) {
            NBTTagList list = (NBTTagList) ((NBTTagList) tag).copy();
            int i = 0;
            if (list.tagCount() == 0) out.put(path, "[]");
            while (list.tagCount() > 0) flatten(list.removeTag(0), path + "[" + i++ + "]", out, depth + 1);
            return;
        }
        if (tag instanceof NBTTagString) {
            String v = ((NBTTagString) tag).func_150285_a_();
            out.put(path, v.length() > 200 ? v.substring(0, 200) + "… (" + v.length() + " characters, " + v.hashCode() + ")" : v);
            return;
        }
        if (tag instanceof NBTTagByteArray) {
            byte[] v = ((NBTTagByteArray) tag).func_150292_c();
            out.put(path, v.length <= 16 ? java.util.Arrays.toString(v) : "(" + v.length + " bytes, " + java.util.Arrays.hashCode(v) + ")");
            return;
        }
        if (tag instanceof NBTTagIntArray) {
            int[] v = ((NBTTagIntArray) tag).func_150302_c();
            out.put(path, v.length <= 16 ? java.util.Arrays.toString(v) : "(" + v.length + " numbers, " + java.util.Arrays.hashCode(v) + ")");
            return;
        }
        if (tag instanceof NBTBase.NBTPrimitive) {
            NBTBase.NBTPrimitive v = (NBTBase.NBTPrimitive) tag;
            byte id = tag.getId();
            out.put(path, id == 5 || id == 6 ? String.valueOf(v.func_150286_g()) : String.valueOf(v.func_150291_c()));
            return;
        }
        out.put(path, tag.toString());
    }

    /** The stack a compound holds, if it is one saved in the game's usual form. */
    private static ItemStack asStack(NBTTagCompound c) {
        if (!c.hasKey("id") || !c.hasKey("Count") || !c.hasKey("Damage")) return null;
        byte idType = c.getTag("id")
            .getId();
        if (idType != 2 && idType != 3) return null;
        try {
            ItemStack s = ItemStack.loadItemStackFromNBT(c);
            return s == null || s.getItem() == null ? null : s;
        } catch (Throwable t) {
            return null;
        }
    }
}
