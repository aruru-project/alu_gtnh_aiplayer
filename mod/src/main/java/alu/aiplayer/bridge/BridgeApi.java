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

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.Reach;
import alu.aiplayer.act.Tools;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.BotManager;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.craft.RecipeBook;
import alu.aiplayer.task.Task;
import alu.aiplayer.task.TaskFactory;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;
import alu.aiplayer.world.BlueprintPlan;
import alu.aiplayer.world.Quests;
import alu.aiplayer.world.PlayerView;
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
            return WorldQueries.block(w, J.reqCoord(p, "x"), J.reqHeight(p, "y"), J.reqCoord(p, "z"));
        });
        bridge.register(
            "world.scan",
            p -> WorldQueries
                .scan(world(p), J.reqCoord(p, "x1"), J.reqCoord(p, "z1"), J.reqCoord(p, "x2"), J.reqCoord(p, "z2")));
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
            int[] c = centre(p);
            return WorldQueries.find(
                world(p),
                c[0],
                c[1],
                c[2],
                Math.max(1, J.i(p, "radius", 16)),
                wanted,
                limit);
        });
        bridge.register("quest.lines", p -> {
            requireQuestBook();
            return Quests.lines(Quests.player(J.str(p, "player", null)));
        });
        bridge.register("quest.search", p -> {
            requireQuestBook();
            String state = J.str(p, "state", null);
            if (state != null && !state.equals("available") && !state.equals("complete") && !state.equals("locked")) {
                throw RpcException.badRequest("state must be available, complete or locked");
            }
            return Quests.search(
                J.str(p, "query", null),
                J.str(p, "line", null),
                state,
                Quests.player(J.str(p, "player", null)),
                Math.max(1, Math.min(60, J.i(p, "limit", 20))));
        });
        bridge.register("quest.progress", p -> {
            requireQuestBook();
            return Quests.progress(J.reqStr(p, "player"));
        });
        bridge.register("quest.get", p -> {
            requireQuestBook();
            return Quests.get(J.reqStr(p, "id"), Quests.player(J.str(p, "player", null)));
        });
        bridge.register("item.search", p -> {
            String query = J.reqStr(p, "query");
            if (query.trim()
                .length() < 2) throw RpcException.badRequest("query needs at least two characters");
            return RecipeBook.get()
                .searchJson(query, Math.max(1, Math.min(40, J.i(p, "limit", 12))));
        });
        bridge.register("recipe.find", p -> {
            RecipeBook book = RecipeBook.get();
            RecipeBook.Entry e = book.entry(J.reqStr(p, "id"), Math.max(0, J.i(p, "meta", 0)));
            if (e == null) {
                throw RpcException
                    .notFound("no such item is known: " + J.reqStr(p, "id") + "/" + J.i(p, "meta", 0) + "; item.search finds ids");
            }
            Bot b = J.has(p, "bot") ? bots.requireOnline(J.reqStr(p, "bot")) : null;
            return book.recipesJson(
                e,
                b == null ? null : b.player(),
                Math.max(0, Math.min(12, J.i(p, "crafting", 4))),
                Math.max(0, Math.min(24, J.i(p, "machines", 8))),
                J.str(p, "machine", null));
        });
        bridge.register("world.machines", p -> {
            int[] c = centre(p);
            return WorldQueries.machines(
                world(p),
                c[0],
                c[1],
                c[2],
                Math.max(1, J.i(p, "radius", 32)),
                J.str(p, "name", null),
                Math.max(1, Math.min(60, J.i(p, "limit", 30))));
        });
        bridge.register("world.stock", p -> {
            JsonArray wanted = J.array(p, "items");
            if (wanted == null || wanted.size() == 0 || wanted.size() > 24) {
                throw RpcException.badRequest("items must list 1 to 24 items");
            }
            int[] c = centre(p);
            return WorldQueries.stock(
                world(p),
                c[0],
                c[1],
                c[2],
                Math.max(1, J.i(p, "radius", 32)),
                wanted);
        });
        bridge.register(
            "blueprint.list",
            p -> AiPlayerMod.blueprints()
                .list());
        bridge.register("blueprint.check", p -> {
            BlueprintPlan plan = BlueprintPlan.fromParams(p);
            Bot b = J.has(p, "bot") ? bots.requireOnline(J.reqStr(p, "bot")) : null;
            return plan.survey(world(p), b == null ? null : b.player(), J.bool(p, "layers", true));
        });
        bridge.register("blueprint.put", p -> {
            byte[] bytes;
            try {
                bytes = java.util.Base64.getDecoder()
                    .decode(J.reqStr(p, "data"));
            } catch (IllegalArgumentException e) {
                throw RpcException.badRequest("data must be the file in base64");
            }
            try {
                return AiPlayerMod.blueprints()
                    .put(J.reqStr(p, "name"), bytes);
            } catch (java.io.IOException e) {
                throw new IllegalStateException("cannot store the blueprint: " + e.getMessage());
            }
        });
        bridge.register(
            "blueprint.remove",
            p -> AiPlayerMod.blueprints()
                .remove(J.reqStr(p, "name")));
        bridge.register("world.containers", p -> {
            int[] c = centre(p);
            return WorldQueries.containers(
                world(p),
                c[0],
                c[1],
                c[2],
                Math.max(0, J.i(p, "radius", 12)),
                Math.max(0, J.i(p, "offset", 0)),
                Math.max(1, Math.min(100, J.i(p, "limit", 40))));
        });
        bridge.register(
            "world.drawers",
            p -> WorldQueries.drawers(
                world(p),
                J.reqCoord(p, "x"),
                J.reqHeight(p, "y"),
                J.reqCoord(p, "z"),
                Math.max(0, J.i(p, "below", 0)),
                Math.max(0, J.i(p, "offset", 0)),
                Math.max(1, Math.min(500, J.i(p, "limit", 200)))));
        bridge.register(
            "world.blocks",
            p -> WorldQueries.blocks(
                world(p),
                J.reqCoord(p, "x1"),
                J.reqHeight(p, "y1"),
                J.reqCoord(p, "z1"),
                J.reqCoord(p, "x2"),
                J.reqHeight(p, "y2"),
                J.reqCoord(p, "z2")));
        bridge.register("world.player", p -> {
            EntityPlayerMP who = MinecraftServer.getServer()
                .getConfigurationManager()
                .func_152612_a(J.reqStr(p, "name"));
            if (who == null) throw RpcException.notFound("no player named " + J.reqStr(p, "name") + " is online");
            JsonObject o = PlayerView.describe(who);
            o.addProperty("name", who.getCommandSenderName());
            o.addProperty("isBot", bots.isBot(who));
            return o;
        });
        bridge.register("world.entities", p -> {
            int[] c = centre(p);
            return WorldQueries
                .entities(world(p), c[0] + 0.5, c[1], c[2] + 0.5, Math.max(1, J.i(p, "radius", 16)));
        });

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
                int y = J.reqHeight(p, "y");
                if (y < 0 || y > 255) throw RpcException.badRequest("y must be between 0 and 255");
                pos = new double[] { J.reqCoord(p, "x") + 0.5, y, J.reqCoord(p, "z") + 0.5 };
            }
            Integer dim = J.has(p, "dim") ? J.i(p, "dim", 0) : null;
            return bots.spawn(J.reqStr(p, "name"), dim, pos, J.object(p, "skin"))
                .status();
        });
        bridge.register("bot.despawn", p -> {
            bots.despawn(bots.require(J.reqStr(p, "bot")));
            return null;
        });
        bridge.register("bot.remove", p -> {
            bots.remove(bots.require(J.reqStr(p, "bot")));
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
            List<String> out = b.runCommand(command);
            JsonArray a = new JsonArray();
            for (String line : out) a.add(J.prim(line));
            JsonObject o = new JsonObject();
            o.add("output", a);
            return o;
        });
        bridge.register("bot.look", p -> {
            Bot b = bots.requireOnline(J.reqStr(p, "bot"));
            Motion.face(b.player(), J.reqCoord(p, "x") + 0.5, J.reqHeight(p, "y") + 0.5, J.reqCoord(p, "z") + 0.5);
            return null;
        });
        bridge.register("bot.probe", p -> {
            Bot b = bots.requireOnline(J.reqStr(p, "bot"));
            int x = J.reqCoord(p, "x"), y = J.reqHeight(p, "y"), z = J.reqCoord(p, "z");
            JsonObject o = WorldQueries.block(b.world(), x, y, z);
            if (y >= 0 && y <= 255 && b.world()
                .blockExists(x, y, z)) {
                Tools.Choice best = Tools.best(b.player(), b.world(), x, y, z);
                o.addProperty("canDig", best != null && best.worthwhile());
                if (best != null) {
                    o.addProperty("digTicks", best.ticks() == Integer.MAX_VALUE ? -1 : best.ticks());
                    o.addProperty("toolSlot", best.slot);
                }
                o.addProperty("inReach", Reach.canReach(b.player(), x, y, z));
                o.add("candidates", Tools.explain(b.player(), b.world(), x, y, z));
            }
            return o;
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
            List<String> replaced = b.tasks.add(t, "append".equals(J.str(p, "mode", "replace")));
            JsonObject o = new JsonObject();
            o.add("task", t.info());
            o.add("replaced", strings(replaced));
            return o;
        });
        bridge.register("task.cancel", p -> {
            Bot b = bots.require(J.reqStr(p, "bot"));
            List<String> ids = b.tasks.cancel(J.str(p, "id", null));
            JsonObject o = new JsonObject();
            o.addProperty("canceled", ids.size());
            o.add("ids", strings(ids));
            return o;
        });
        bridge.register(
            "task.list",
            p -> bots.require(J.reqStr(p, "bot")).tasks.list());
    }

    private static JsonArray strings(List<String> values) {
        JsonArray a = new JsonArray();
        for (String v : values) a.add(J.prim(v));
        return a;
    }

    /** The point a search is centred on: x, y, z if given, else where the named bot stands. */
    private int[] centre(JsonObject p) {
        if (J.has(p, "x") && J.has(p, "y") && J.has(p, "z")) {
            return new int[] { J.reqCoord(p, "x"), J.reqHeight(p, "y"), J.reqCoord(p, "z") };
        }
        if (!J.has(p, "bot")) throw RpcException.badRequest("give x, y, z or a bot to centre on");
        Bot b = bots.requireOnline(J.reqStr(p, "bot"));
        return new int[] { b.blockX(), b.blockY(), b.blockZ() };
    }

    private static void requireQuestBook() {
        if (!Quests.present()) throw RpcException.notFound("this server has no quest book (BetterQuesting)");
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
