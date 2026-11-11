package alu.aiplayer.world;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.J;

/**
 * The plans a bot can build from: the {@code .schematic} files in {@code config/aiplayer/schematics}. Files may be
 * dropped into the folder at any time; they are read when asked for and read again when they change.
 */
public final class BlueprintStore {

    private static final String SUFFIX = ".schematic";
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private static final int MAX_FILES = 500;

    private static final class Cached {

        long modified, length;
        Blueprint blueprint;
        String error;
    }

    private final File dir;
    private final Map<String, Cached> cache = new HashMap<>();

    public BlueprintStore(File dir) {
        this.dir = dir;
    }

    /** A name is a file name without the suffix: no folders, nothing hidden. */
    private static String checkName(String name) {
        if (name == null) throw new IllegalArgumentException("a blueprint name is required");
        if (name.endsWith(SUFFIX)) name = name.substring(0, name.length() - SUFFIX.length());
        if (name.isEmpty() || name.length() > 80
            || name.startsWith(".")
            || name.contains("..")
            || !name.matches("[^/\\\\:*?\"<>|\\p{Cntrl}]+")) {
            throw new IllegalArgumentException("not a usable blueprint name: " + name);
        }
        return name;
    }

    private File file(String name) {
        return new File(dir, name + SUFFIX);
    }

    private Cached load(String name) {
        File f = file(name);
        if (!f.isFile()) {
            cache.remove(name);
            return null;
        }
        Cached c = cache.get(name);
        if (c != null && c.modified == f.lastModified() && c.length == f.length()) return c;
        c = new Cached();
        c.modified = f.lastModified();
        c.length = f.length();
        if (c.length > MAX_BYTES) {
            c.error = "the file is larger than " + MAX_BYTES / 1024 + " KiB";
        } else {
            try (InputStream in = new FileInputStream(f)) {
                c.blueprint = Blueprint.read(name, in);
            } catch (IllegalArgumentException e) {
                c.error = e.getMessage();
            } catch (IOException | RuntimeException e) {
                c.error = "cannot be read: " + e;
            }
        }
        cache.put(name, c);
        return c;
    }

    /** The plan of that name. Throws IllegalArgumentException when there is none or the file is unusable. */
    public Blueprint get(String name) {
        name = checkName(name);
        Cached c = load(name);
        if (c == null) {
            throw new IllegalArgumentException(
                "there is no blueprint named \"" + name + "\"; blueprint.list shows the ones there are");
        }
        if (c.blueprint == null) throw new IllegalArgumentException("blueprint \"" + name + "\": " + c.error);
        return c.blueprint;
    }

    public JsonObject list() {
        JsonArray out = new JsonArray();
        File[] files = dir.listFiles();
        if (files != null) {
            Arrays.sort(files);
            for (File f : files) {
                String n = f.getName();
                if (!f.isFile() || !n.endsWith(SUFFIX) || out.size() >= MAX_FILES) continue;
                String name = n.substring(0, n.length() - SUFFIX.length());
                JsonObject o = new JsonObject();
                o.addProperty("name", name);
                Cached c;
                try {
                    c = load(checkName(name));
                } catch (IllegalArgumentException e) {
                    continue;
                }
                if (c == null) continue;
                if (c.blueprint == null) o.addProperty("error", c.error);
                else describe(o, c.blueprint);
                out.add(o);
            }
        }
        JsonObject o = new JsonObject();
        o.add("blueprints", out);
        o.addProperty("folder", dir.getPath());
        return o;
    }

    /** At most this many cells are written out by one read; a larger plan is read a part at a time. */
    private static final int MAX_READ_CELLS = 64 * 64 * 64;

    /**
     * What a plan holds, as data: every kind of block in it with its count, and the cells themselves in the
     * palette-and-runs form world.blocks uses, for the box from..to inside the plan (both counted from its lowest
     * corner, both included; the whole plan when not given).
     */
    public JsonObject read(String name, int[] from, int[] to, boolean cells) {
        Blueprint b = get(name);
        JsonObject o = new JsonObject();
        o.addProperty("name", b.name);
        describe(o, b);
        List<Blueprint.Kind> kinds = new ArrayList<>();
        for (Blueprint.Kind k : b.kinds) if (!k.empty() && k.count > 0) kinds.add(k);
        Collections.sort(kinds, (x, y) -> y.count - x.count);
        JsonArray materials = new JsonArray();
        for (Blueprint.Kind k : kinds) {
            JsonObject m = kind(k);
            m.addProperty("count", k.count);
            materials.add(m);
        }
        o.add("materials", materials);
        if (!cells) return o;
        int x1 = from == null ? 0 : from[0], y1 = from == null ? 0 : from[1], z1 = from == null ? 0 : from[2];
        int x2 = to == null ? b.sx - 1 : Math.min(to[0], b.sx - 1), y2 = to == null ? b.sy - 1 : Math.min(to[1], b.sy - 1),
            z2 = to == null ? b.sz - 1 : Math.min(to[2], b.sz - 1);
        if (x1 < 0 || y1 < 0 || z1 < 0 || x2 < x1 || y2 < y1 || z2 < z1) {
            throw RpcException.badRequest(
                "from and to are positions inside the plan, counted from 0 at its lowest corner; it is " + b.sx
                    + " x "
                    + b.sy
                    + " x "
                    + b.sz);
        }
        long count = (long) (x2 - x1 + 1) * (y2 - y1 + 1) * (z2 - z1 + 1);
        if (count > MAX_READ_CELLS) {
            throw RpcException.tooLarge(
                "that is " + count
                    + " cells; one read gives at most "
                    + MAX_READ_CELLS
                    + ": give from and to and read the plan a part at a time (cells:false gives the materials alone)");
        }
        int[] index = new int[b.kinds.length];
        Arrays.fill(index, -1);
        index[0] = 0;
        JsonArray palette = new JsonArray();
        JsonObject air = new JsonObject();
        air.addProperty("id", "minecraft:air");
        air.addProperty("meta", 0);
        palette.add(air);
        JsonArray runs = new JsonArray();
        int last = -1, run = 0;
        for (int y = y1; y <= y2; y++) for (int z = z1; z <= z2; z++) for (int x = x1; x <= x2; x++) {
            Blueprint.Kind k = b.at(x, y, z);
            if (index[k.index] < 0) {
                palette.add(kind(k));
                index[k.index] = palette.size() - 1;
            }
            int i = index[k.index];
            if (i == last) {
                run++;
            } else {
                if (run > 0) {
                    runs.add(J.prim(last));
                    runs.add(J.prim(run));
                }
                last = i;
                run = 1;
            }
        }
        if (run > 0) {
            runs.add(J.prim(last));
            runs.add(J.prim(run));
        }
        o.addProperty("x", x1);
        o.addProperty("y", y1);
        o.addProperty("z", z1);
        o.addProperty("sx", x2 - x1 + 1);
        o.addProperty("sy", y2 - y1 + 1);
        o.addProperty("sz", z2 - z1 + 1);
        o.add("palette", palette);
        o.add("runs", runs);
        return o;
    }

    private static JsonObject kind(Blueprint.Kind k) {
        JsonObject m = new JsonObject();
        m.addProperty("id", k.blockId);
        m.addProperty("meta", k.meta);
        m.addProperty("name", k.name);
        // The item that places it, when that is not simply the block under the same name.
        if (k.item != null && !(k.item.id.equals(k.blockId) && k.item.meta == k.meta)) m.add("item", k.item.toJson());
        if (k.byHand != null) m.addProperty("byHand", k.byHand);
        return m;
    }

    private static void describe(JsonObject o, Blueprint b) {
        JsonObject size = new JsonObject();
        size.addProperty("x", b.sx);
        size.addProperty("y", b.sy);
        size.addProperty("z", b.sz);
        o.add("size", size);
        o.addProperty("blocks", b.blocks);
    }

    /** Stores a plan under a name, replacing any there. The bytes must be a readable schematic. */
    public JsonObject put(String name, byte[] bytes) throws IOException {
        name = checkName(name);
        if (bytes.length > MAX_BYTES) {
            throw new IllegalArgumentException("the file is larger than " + MAX_BYTES / 1024 + " KiB");
        }
        Blueprint b = Blueprint.read(name, new ByteArrayInputStream(bytes));
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create " + dir);
        File[] existing = dir.listFiles();
        if (existing != null && existing.length >= MAX_FILES && !file(name).exists()) {
            throw new IllegalArgumentException("the folder already holds " + MAX_FILES + " files");
        }
        File tmp = new File(dir, name + SUFFIX + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
        }
        File target = file(name);
        if (target.exists() && !target.delete()) throw new IOException("cannot replace " + target);
        if (!tmp.renameTo(target)) throw new IOException("cannot write " + target);
        cache.remove(name);
        AiPlayerMod.LOG.info("Stored blueprint {} ({} blocks)", name, b.blocks);
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        describe(o, b);
        return o;
    }

    public JsonObject remove(String name) {
        name = checkName(name);
        File f = file(name);
        boolean was = f.isFile();
        if (was && !f.delete()) throw new IllegalStateException("cannot delete " + f);
        cache.remove(name);
        JsonObject o = new JsonObject();
        o.addProperty("removed", was);
        return o;
    }
}
