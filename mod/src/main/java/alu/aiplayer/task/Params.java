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
        return new int[] { J.reqInt(o, "x"), J.reqInt(o, "y"), J.reqInt(o, "z") };
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
