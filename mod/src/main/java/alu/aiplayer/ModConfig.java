package alu.aiplayer;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.util.J;

/** Settings in config/aiplayer/aiplayer.json. Missing keys are filled with defaults and written back. */
public final class ModConfig {

    public String bridgeHost = "127.0.0.1";
    public int bridgePort = 25590;
    public int maxBots = 4;
    public boolean defaultInvulnerable = true;
    public boolean defaultHunger = false;
    /**
     * Commands a bot may run. An entry is one or more words; a command is allowed when it begins with all the words
     * of some entry ("team join" allows "team join base" but not "team leave").
     */
    public Set<String> allowedCommands = new HashSet<>(
        Arrays.asList(
            "home",
            "sethome",
            "delhome",
            "homes",
            "spawn",
            "back",
            "tell",
            "msg",
            "w",
            "tpa",
            "tpaccept",
            "team join"));
    /** How far, in blocks, a task may send a bot on foot. Farther than this it should use /home first. */
    public int maxTravel = 256;
    /**
     * Tools the bot never digs with: ones that break several blocks at once, which would reach outside the area a
     * task was given.
     */
    public Set<String> excludedTools = new HashSet<>(
        Arrays.asList(
            "TConstruct:hammer",
            "TConstruct:excavator",
            "TConstruct:lumberaxe",
            "TConstruct:scythe",
            "TConstruct:mattock"));
    /**
     * Blocks a bot may break on its own initiative while finding a way (outside the region a task names).
     * Anything else outside a task region is left alone, so walking around never damages a base. Stone, wood and
     * the like are deliberately absent: people build with them.
     */
    public Set<String> naturalBlocks = new HashSet<>(
        Arrays.asList(
            "minecraft:dirt",
            "minecraft:grass",
            "minecraft:sand",
            "minecraft:gravel",
            "minecraft:snow",
            "minecraft:snow_layer",
            "minecraft:clay",
            "minecraft:mycelium",
            "minecraft:netherrack",
            "minecraft:leaves",
            "minecraft:leaves2",
            "minecraft:tallgrass",
            "minecraft:double_plant",
            "minecraft:deadbush",
            "minecraft:red_flower",
            "minecraft:yellow_flower",
            "minecraft:vine",
            "minecraft:cactus",
            "minecraft:reeds",
            "minecraft:web"));
    /** Blocks used as throwaway filler and scaffolding, in order of preference. */
    public List<String> fillerBlocks = new ArrayList<>(
        Arrays.asList("minecraft:dirt", "minecraft:cobblestone", "minecraft:stone", "minecraft:netherrack"));

    public static ModConfig load(File file) {
        ModConfig c = new ModConfig();
        JsonObject o = new JsonObject();
        try {
            if (file.isFile()) {
                o = J.parseObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            AiPlayerMod.LOG.error("Cannot read {}; using defaults", file, e);
        }
        c.bridgeHost = J.str(o, "bridgeHost", c.bridgeHost);
        c.bridgePort = J.i(o, "bridgePort", c.bridgePort);
        c.maxBots = J.i(o, "maxBots", c.maxBots);
        c.defaultInvulnerable = J.bool(o, "defaultInvulnerable", c.defaultInvulnerable);
        c.defaultHunger = J.bool(o, "defaultHunger", c.defaultHunger);
        c.allowedCommands = stringSet(o, "allowedCommands", c.allowedCommands);
        c.maxTravel = Math.max(16, J.i(o, "maxTravel", c.maxTravel));
        c.excludedTools = stringSet(o, "excludedTools", c.excludedTools);
        c.naturalBlocks = stringSet(o, "naturalBlocks", c.naturalBlocks);
        JsonArray filler = J.array(o, "fillerBlocks");
        if (filler != null) {
            c.fillerBlocks = new ArrayList<>();
            for (JsonElement e : filler) c.fillerBlocks.add(e.getAsString());
        }
        c.save(file);
        return c;
    }

    /** Whether a command line (without the slash) is one the bots may run. */
    public boolean commandAllowed(String command) {
        String[] words = command.trim()
            .toLowerCase()
            .split("\\s+");
        for (String entry : allowedCommands) {
            String[] want = entry.trim()
                .toLowerCase()
                .split("\\s+");
            if (want.length == 0 || want.length > words.length) continue;
            boolean match = true;
            for (int i = 0; i < want.length; i++) if (!want[i].equals(words[i])) match = false;
            if (match) return true;
        }
        return false;
    }

    private static Set<String> stringSet(JsonObject o, String key, Set<String> def) {
        JsonArray a = J.array(o, key);
        if (a == null) return def;
        Set<String> out = new HashSet<>();
        for (JsonElement e : a) out.add(e.getAsString());
        return out;
    }

    private void save(File file) {
        JsonObject o = new JsonObject();
        o.addProperty("bridgeHost", bridgeHost);
        o.addProperty("bridgePort", bridgePort);
        o.addProperty("maxBots", maxBots);
        o.addProperty("defaultInvulnerable", defaultInvulnerable);
        o.addProperty("defaultHunger", defaultHunger);
        o.add("allowedCommands", toArray(new java.util.TreeSet<>(allowedCommands)));
        o.addProperty("maxTravel", maxTravel);
        o.add("excludedTools", toArray(new java.util.TreeSet<>(excludedTools)));
        o.add("naturalBlocks", toArray(new java.util.TreeSet<>(naturalBlocks)));
        o.add("fillerBlocks", toArray(fillerBlocks));
        try {
            file.getParentFile()
                .mkdirs();
            String text = new GsonBuilder().setPrettyPrinting()
                .create()
                .toJson(o);
            Files.write(file.toPath(), (text + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            AiPlayerMod.LOG.warn("Cannot write {}", file, e);
        }
    }

    private static JsonArray toArray(Iterable<String> values) {
        JsonArray a = new JsonArray();
        for (String v : values) a.add(J.prim(v));
        return a;
    }
}
