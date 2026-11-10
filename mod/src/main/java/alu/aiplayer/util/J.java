package alu.aiplayer.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

/** Small helpers over the Gson 2.2 tree API that ships with Minecraft 1.7.10. */
public final class J {

    private J() {}

    public static JsonObject obj() {
        return new JsonObject();
    }

    public static JsonArray arr() {
        return new JsonArray();
    }

    public static JsonObject parseObject(String text) {
        JsonElement e = new JsonParser().parse(text);
        if (!e.isJsonObject()) throw new IllegalArgumentException("expected a JSON object");
        return e.getAsJsonObject();
    }

    public static JsonElement prim(String v) {
        return v == null ? JsonNull.INSTANCE : new JsonPrimitive(v);
    }

    public static JsonElement prim(Number v) {
        return v == null ? JsonNull.INSTANCE : new JsonPrimitive(v);
    }

    public static boolean has(JsonObject o, String key) {
        return o != null && o.has(key) && !o.get(key).isJsonNull();
    }

    public static String str(JsonObject o, String key, String def) {
        if (!has(o, key)) return def;
        JsonElement e = o.get(key);
        return e.isJsonPrimitive() ? e.getAsString() : def;
    }

    public static int i(JsonObject o, String key, int def) {
        if (!has(o, key)) return def;
        try {
            return (int) Math.floor(o.get(key).getAsDouble());
        } catch (RuntimeException e) {
            return def;
        }
    }

    public static long l(JsonObject o, String key, long def) {
        if (!has(o, key)) return def;
        try {
            return o.get(key).getAsLong();
        } catch (RuntimeException e) {
            return def;
        }
    }

    public static double d(JsonObject o, String key, double def) {
        if (!has(o, key)) return def;
        try {
            return o.get(key).getAsDouble();
        } catch (RuntimeException e) {
            return def;
        }
    }

    public static boolean bool(JsonObject o, String key, boolean def) {
        if (!has(o, key)) return def;
        try {
            return o.get(key).getAsBoolean();
        } catch (RuntimeException e) {
            return def;
        }
    }

    public static JsonObject object(JsonObject o, String key) {
        return has(o, key) && o.get(key).isJsonObject() ? o.getAsJsonObject(key) : null;
    }

    public static JsonArray array(JsonObject o, String key) {
        return has(o, key) && o.get(key).isJsonArray() ? o.getAsJsonArray(key) : null;
    }

    /** Requires an integer field; throws a readable error otherwise. */
    public static int reqInt(JsonObject o, String key) {
        if (!has(o, key) || !o.get(key).isJsonPrimitive() || !o.get(key).getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException("missing or non-numeric field: " + key);
        }
        return (int) Math.floor(o.get(key).getAsDouble());
    }

    /** The largest horizontal coordinate the game itself accepts. */
    public static final int WORLD_LIMIT = 30000000;

    /** A horizontal block coordinate, checked against the world border so later arithmetic cannot overflow. */
    public static int reqCoord(JsonObject o, String key) {
        int v = reqInt(o, key);
        if (v < -WORLD_LIMIT || v > WORLD_LIMIT) throw new IllegalArgumentException(key + " is outside the world");
        return v;
    }

    /** A height; anything from far below the world to far above it is accepted and means what it says. */
    public static int reqHeight(JsonObject o, String key) {
        int v = reqInt(o, key);
        if (v < -1024 || v > 1024) throw new IllegalArgumentException(key + " is not a sensible height");
        return v;
    }

    public static String reqStr(JsonObject o, String key) {
        String s = str(o, key, null);
        if (s == null || s.isEmpty()) throw new IllegalArgumentException("missing field: " + key);
        return s;
    }

    public static JsonObject pos(int x, int y, int z) {
        JsonObject o = new JsonObject();
        o.addProperty("x", x);
        o.addProperty("y", y);
        o.addProperty("z", z);
        return o;
    }

    public static JsonObject pos(double x, double y, double z) {
        JsonObject o = new JsonObject();
        o.addProperty("x", round(x));
        o.addProperty("y", round(y));
        o.addProperty("z", round(z));
        return o;
    }

    public static double round(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
