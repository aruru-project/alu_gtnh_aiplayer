package alu.aiplayer.export;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraftforge.oredict.OreDictionary;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import alu.aiplayer.AiPlayerMod;
import codechicken.nei.ItemList;

/**
 * The lines of an items.jsonl that is already written, for the exports that go over it again (icons, tooltips):
 * which item each line is, the stack that stands for it, and the digest that says which list this was.
 * <p>
 * The stack of a line is the first one NEI lists with that id and damage value (so a tool that only is something
 * with its tag is the one NEI shows first, the one the line's name came from), or a bare stack when NEI does not
 * list it. A line that asks for any damage value stands for damage value 0.
 */
final class ItemRows {

    final List<String> ids = new ArrayList<>();
    final List<Integer> metas = new ArrayList<>();
    /** SHA-1 over {@code id/meta\n} of every line in order; what icons.json and meta.json call itemsSha1. */
    final String sha1;
    private final Map<String, ItemStack> listed = new HashMap<>();

    ItemRows(File dir) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-1");
        JsonParser parser = new JsonParser();
        try (BufferedReader in = new BufferedReader(
            new InputStreamReader(new FileInputStream(new File(dir, "items.jsonl")), StandardCharsets.UTF_8))) {
            for (String line = in.readLine(); line != null; line = in.readLine()) {
                String id = "";
                int meta = 0;
                try {
                    JsonObject o = parser.parse(line)
                        .getAsJsonObject();
                    String readId = o.get("id")
                        .getAsString();
                    meta = o.get("meta")
                        .getAsInt();
                    id = readId;
                } catch (Throwable ignored) {
                    // A line nobody can read still takes its place, so that the lines after it keep their numbers.
                    meta = 0;
                }
                ids.add(id);
                metas.add(meta);
                digest.update((id + "/" + meta + "\n").getBytes(StandardCharsets.UTF_8));
            }
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format("%02x", b & 255));
        sha1 = hex.toString();
        try {
            for (ItemStack s : new ArrayList<>(ItemList.items)) {
                if (s == null || s.getItem() == null) continue;
                Object name = Item.itemRegistry.getNameForObject(s.getItem());
                if (name != null) listed.putIfAbsent(name + "/" + s.getItemDamage(), s);
            }
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("export: NEI's item list could not be read, every line stands for a bare stack", t);
        }
    }

    int size() {
        return ids.size();
    }

    /** How many of the lines stand for a stack NEI lists. */
    int countListed() {
        int n = 0;
        for (int i = 0; i < ids.size(); i++) if (listed.containsKey(ids.get(i) + "/" + metas.get(i))) n++;
        return n;
    }

    /** A fresh stack for line {@code i}, or null when the game has no such item. */
    ItemStack stack(int i) {
        try {
            String id = ids.get(i);
            int meta = metas.get(i);
            ItemStack known = listed.get(id + "/" + meta);
            ItemStack s;
            if (known != null) {
                s = known.copy();
            } else {
                Item item = (Item) Item.itemRegistry.getObject(id);
                if (item == null) return null;
                s = new ItemStack(item, 1, meta == OreDictionary.WILDCARD_VALUE ? 0 : meta);
            }
            s.stackSize = 1;
            return s;
        } catch (Throwable t) {
            return null;
        }
    }
}
