package alu.aiplayer.bridge;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.DimensionManager;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.act.Inventories;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.BotManager;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.task.Task;
import alu.aiplayer.task.TaskFactory;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;
import alu.aiplayer.world.WorldQueries;

/** The bridge methods of docs/PROTOCOL.md. Each runs on the server thread. */
public final class BridgeApi {

    private final BridgeServer bridge;
    private final BotManager bots;

    public BridgeApi(BridgeServer bridge, BotManager bots) {
        this.bridge = bridge;
        this.bots = bots;
    }

    public void registerAll() {
        bridge.register("server.info", p -> serverInfo());

        bridge.register("world.block", p -> {
            WorldServer w = world(p);
            return WorldQueries.block(w, J.reqInt(p, "x"), J.reqInt(p, "y"), J.reqInt(p, "z"));
        });
        bridge.register(
            "world.scan",
            p -> WorldQueries
                .scan(world(p), J.reqInt(p, "x1"), J.reqInt(p, "z1"), J.reqInt(p, "x2"), J.reqInt(p, "z2")));
        bridge.register("world.find", p -> {
            Set<Block> wanted = new HashSet<>();
            JsonArray ids = J.array(p, "blocks");
            if (ids == null || ids.size() == 0) throw RpcException.badRequest("blocks must list block ids");
            for (JsonElement e : ids) {
                Block b = Names.block(e.getAsString());
                if (b == null) throw RpcException.badRequest("unknown block id: " + e.getAsString());
                wanted.add(b);
            }
            int limit = Math.max(1, Math.min(64, J.i(p, "limit", 16)));
            return WorldQueries.find(
                world(p),
                J.reqInt(p, "x"),
                J.reqInt(p, "y"),
                J.reqInt(p, "z"),
                Math.max(1, J.i(p, "radius", 16)),
                wanted,
                limit);
        });
        bridge.register(
            "world.containers",
            p -> WorldQueries.containers(
                world(p),
                J.reqInt(p, "x"),
                J.reqInt(p, "y"),
                J.reqInt(p, "z"),
                Math.max(1, J.i(p, "radius", 12))));
        bridge.register(
            "world.entities",
            p -> WorldQueries.entities(
                world(p),
                J.reqInt(p, "x") + 0.5,
                J.reqInt(p, "y"),
                J.reqInt(p, "z") + 0.5,
                Math.max(1, J.i(p, "radius", 16))));

        bridge.register("bot.list", p -> {
            JsonArray a = new JsonArray();
            for (JsonObject b : bots.briefs()) a.add(b);
            JsonObject o = new JsonObject();
            o.add("bots", a);
            return o;
        });
        bridge.register("bot.spawn", p -> {
            double[] pos = null;
            if (J.has(p, "x") && J.has(p, "y") && J.has(p, "z")) {
                pos = new double[] { J.d(p, "x", 0) + 0.5, J.d(p, "y", 0), J.d(p, "z", 0) + 0.5 };
            }
            Integer dim = J.has(p, "dim") ? J.i(p, "dim", 0) : null;
            return bots.spawn(J.reqStr(p, "name"), dim, pos, J.object(p, "skin"))
                .status();
        });
        bridge.register("bot.despawn", p -> {
            bots.despawn(bots.require(J.reqStr(p, "bot")));
            return null;
        });
        bridge.register(
            "bot.status",
            p -> bots.require(J.reqStr(p, "bot"))
                .status());
        bridge.register("bot.configure", p -> {
            Bot b = bots.require(J.reqStr(p, "bot"));
            JsonObject s = J.object(p, "settings");
            if (s != null) {
                b.invulnerable = J.bool(s, "invulnerable", b.invulnerable);
                b.hunger = J.bool(s, "hunger", b.hunger);
                bots.markDirty();
            }
            JsonObject o = new JsonObject();
            o.add(
                "settings",
                b.status()
                    .get("settings"));
            return o;
        });
        bridge.register("bot.chat", p -> {
            bots.requireOnline(J.reqStr(p, "bot"))
                .say(J.reqStr(p, "message"));
            return null;
        });
        bridge.register("bot.command", p -> {
            Bot b = bots.requireOnline(J.reqStr(p, "bot"));
            String command = J.reqStr(p, "command")
                .trim();
            if (command.startsWith("/")) command = command.substring(1);
            String word = command.split("\\s+", 2)[0].toLowerCase();
            if (!bots.config().allowedCommands.contains(word)) {
                throw RpcException.denied("command is not on the bot allow list: " + word);
            }
            List<String> out = b.runCommand(command);
            JsonArray a = new JsonArray();
            for (String line : out) a.add(J.prim(line));
            JsonObject o = new JsonObject();
            o.add("output", a);
            return o;
        });
        bridge.register("bot.look", p -> {
            Bot b = bots.requireOnline(J.reqStr(p, "bot"));
            Motion.face(b.player(), J.reqInt(p, "x") + 0.5, J.reqInt(p, "y") + 0.5, J.reqInt(p, "z") + 0.5);
            return null;
        });
        bridge.register("bot.drop", p -> {
            Bot b = bots.requireOnline(J.reqStr(p, "bot"));
            int n = Inventories.drop(b, J.bool(p, "all", false) ? null : Inventories.filters(J.array(p, "items")));
            JsonObject o = new JsonObject();
            o.addProperty("dropped", n);
            return o;
        });

        bridge.register("task.start", p -> {
            Bot b = bots.requireOnline(J.reqStr(p, "bot"));
            JsonObject spec = J.object(p, "task");
            if (spec == null) throw RpcException.badRequest("task is required");
            Task t = TaskFactory.create(J.reqStr(spec, "type"), spec);
            b.tasks.add(t, "append".equals(J.str(p, "mode", "replace")));
            JsonObject o = new JsonObject();
            o.add("task", t.info());
            return o;
        });
        bridge.register("task.cancel", p -> {
            Bot b = bots.require(J.reqStr(p, "bot"));
            JsonObject o = new JsonObject();
            o.addProperty("canceled", b.tasks.cancel(J.str(p, "id", null)));
            return o;
        });
        bridge.register(
            "task.list",
            p -> bots.require(J.reqStr(p, "bot")).tasks.list());
    }

    /** The world a request is about: its dim, else the world of the bot it names, else the overworld. */
    private WorldServer world(JsonObject p) {
        int dim = 0;
        if (J.has(p, "dim")) {
            dim = J.i(p, "dim", 0);
        } else if (J.has(p, "bot")) {
            Bot b = bots.find(J.str(p, "bot", null));
            if (b != null && b.online()) dim = b.player().dimension;
        }
        WorldServer w = DimensionManager.getWorld(dim);
        if (w == null) throw RpcException.notFound("dimension is not loaded: " + dim);
        return w;
    }

    private JsonObject serverInfo() {
        MinecraftServer server = MinecraftServer.getServer();
        WorldServer overworld = server.worldServerForDimension(0);
        JsonObject o = new JsonObject();
        o.addProperty("tick", server.getTickCounter());
        long sum = 0;
        for (long t : server.tickTimeArray) sum += t;
        double meanMs = sum / (double) server.tickTimeArray.length / 1.0e6;
        o.addProperty("tps", J.round(Math.min(20.0, 1000.0 / Math.max(meanMs, 0.001))));
        o.addProperty("tickMs", J.round(meanMs));
        long worldTime = overworld.getWorldTime();
        o.addProperty("worldTime", worldTime);
        o.addProperty("dayTime", worldTime % 24000L);
        o.addProperty("isDay", worldTime % 24000L < 12500L);
        o.addProperty("raining", overworld.isRaining());
        o.addProperty("difficulty", overworld.difficultySetting.getDifficultyId());
        JsonArray players = new JsonArray();
        for (Object e : server.getConfigurationManager().playerEntityList) {
            EntityPlayerMP pl = (EntityPlayerMP) e;
            JsonObject j = new JsonObject();
            j.addProperty("name", pl.getCommandSenderName());
            j.addProperty(
                "uuid",
                pl.getUniqueID()
                    .toString());
            j.addProperty("dim", pl.dimension);
            j.add("pos", J.pos(pl.posX, pl.posY, pl.posZ));
            j.addProperty("isBot", bots.isBot(pl));
            players.add(j);
        }
        o.add("players", players);
        JsonArray names = new JsonArray();
        for (Bot b : bots.all()) names.add(J.prim(b.name));
        o.add("bots", names);
        return o;
    }
}
