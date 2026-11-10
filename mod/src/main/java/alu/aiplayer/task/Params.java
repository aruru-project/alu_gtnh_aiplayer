package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.util.J;

/** Reading the shapes that recur in task params. */
final class Params {

    private Params() {}

    static int[] pos(JsonObject o) {
        if (o == null) throw new IllegalArgumentException("a position {x,y,z} is required");
        int y = J.reqHeight(o, "y");
        if (y < 0 || y > 255) throw new IllegalArgumentException("y must be between 0 and 255");
        return new int[] { J.reqCoord(o, "x"), y, J.reqCoord(o, "z") };
    }

    /**
     * For a container that may also be "the bag I carry": {@code {item:{id, meta?}}} in place of a position.
     * Null when the parameter is a position (or absent).
     */
    static alu.aiplayer.act.ItemFilter carried(JsonObject params, String key) {
        JsonObject o = J.object(params, key);
        if (o == null || !J.has(o, "item")) return null;
        JsonObject item = J.object(o, "item");
        if (item == null) throw new IllegalArgumentException(key + ".item must be {id, meta?}");
        String id = J.reqStr(item, "id");
        if (alu.aiplayer.util.Names.item(id) == null) throw new IllegalArgumentException("unknown item id: " + id);
        return new alu.aiplayer.act.ItemFilter(id, J.has(item, "meta") ? J.i(item, "meta", 0) : -1, 1);
    }

    static int[] pos(JsonObject params, String key) {
        JsonObject o = J.object(params, key);
        if (o == null) throw new IllegalArgumentException(key + " must be a position {x,y,z}");
        return pos(o);
    }

    /** A position or an array of positions; empty when absent. */
    static List<int[]> posList(JsonObject params, String key) {
        List<int[]> out = new ArrayList<>();
        if (!J.has(params, key)) return out;
        JsonElement e = params.get(key);
        if (e.isJsonObject()) {
            out.add(pos(e.getAsJsonObject()));
        } else if (e.isJsonArray()) {
            for (JsonElement i : e.getAsJsonArray()) out.add(pos(i.getAsJsonObject()));
        } else {
            throw new IllegalArgumentException(key + " must be a position or a list of positions");
        }
        return out;
    }

    static List<String> strings(JsonObject params, String key) {
        List<String> out = new ArrayList<>();
        JsonArray a = J.array(params, key);
        if (a != null) for (JsonElement e : a) out.add(e.getAsString());
        return out;
    }
}
