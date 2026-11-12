package alu.aiplayer.util;

import java.util.LinkedHashMap;
import java.util.Map;

import net.minecraft.item.ItemStack;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * Things counted by kind, a kind being an item id and meta: what was placed, what a machine made. Each kind is kept
 * as the bridge lists items, {id, meta, name, count}, in the order first met.
 */
public final class Kinds {

    private final Map<String, JsonObject> byKind = new LinkedHashMap<>();

    public static String key(ItemStack stack) {
        return Names.itemId(stack.getItem()) + "@" + Names.meta(stack);
    }

    public static String key(JsonObject item) {
        return item.get("id")
            .getAsString() + "@"
            + item.get("meta")
                .getAsInt();
    }

    /** One kind of thing, {id, meta, name}: a stack described without its count and wear. */
    public static JsonObject of(ItemStack stack) {
        JsonObject o = Names.describe(stack);
        o.remove("count");
        o.remove("durability");
        return o;
    }

    public void add(ItemStack stack, int count) {
        add(key(stack), of(stack), count);
    }

    /** Adds {@code item}'s own count of its kind. */
    public void add(JsonObject item) {
        JsonObject kind = new JsonObject();
        for (Map.Entry<String, JsonElement> e : item.entrySet()) {
            if (!e.getKey()
                .equals("count")
                && !e.getKey()
                    .equals("durability"))
                kind.add(e.getKey(), e.getValue());
        }
        add(key(item), kind, item.get("count")
            .getAsInt());
    }

    private void add(String key, JsonObject kind, int count) {
        JsonObject had = byKind.get(key);
        if (had == null) {
            kind.addProperty("count", count);
            byKind.put(key, kind);
        } else {
            had.addProperty(
                "count",
                had.get("count")
                    .getAsInt() + count);
        }
    }

    public boolean isEmpty() {
        return byKind.isEmpty();
    }

    public java.util.Set<String> keys() {
        return byKind.keySet();
    }

    public JsonArray toJson() {
        JsonArray out = new JsonArray();
        for (JsonObject kind : byKind.values()) out.add(kind);
        return out;
    }
}
