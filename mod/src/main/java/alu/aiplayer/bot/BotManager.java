package alu.aiplayer.bot;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.management.ServerConfigurationManager;
import net.minecraft.util.ChatComponentText;
import net.minecraftforge.common.DimensionManager;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import com.mojang.authlib.properties.Property;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.ModConfig;
import alu.aiplayer.bridge.BridgeServer;
import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.task.Task;
import alu.aiplayer.task.TaskQueue;
import alu.aiplayer.util.J;

/** All bots known to this world: who exists, who is online, and the save file that remembers both. */
public final class BotManager implements TaskQueue.Listener {

    private final ModConfig config;
    private final BridgeServer bridge;
    private final Map<String, Bot> bots = new LinkedHashMap<>();
    private File saveFile;
    private boolean dirty;
    private int ticksSinceSave;

    public BotManager(ModConfig config, BridgeServer bridge) {
        this.config = config;
        this.bridge = bridge;
    }

    public ModConfig config() {
        return config;
    }

    public Collection<Bot> all() {
        return bots.values();
    }

    public Bot find(String name) {
        return name == null ? null : bots.get(name.toLowerCase());
    }

    /** The bot with that name, or a protocol error. */
    public Bot require(String name) {
        Bot b = find(name);
        if (b == null) throw RpcException.notFound("no such bot: " + name);
        return b;
    }

    public Bot requireOnline(String name) {
        Bot b = require(name);
        if (!b.online()) throw RpcException.offline("bot is offline: " + b.name);
        return b;
    }

    /** True when the entity is one of our bots rather than a person. */
    public boolean isBot(EntityPlayer player) {
        return player instanceof EntityPlayerMP
            && ((EntityPlayerMP) player).playerNetServerHandler instanceof BotConnection;
    }

    public Bot botOf(EntityPlayer player) {
        if (!isBot(player)) return null;
        return find(player.getCommandSenderName());
    }

    // ---- lifecycle ------------------------------------------------------------------------------------------

    public void onServerStarted() {
        saveFile = new File(DimensionManager.getCurrentSaveRootDirectory(), "aiplayer/bots.json");
        load();
        // Other mods finish their own start-up in the same event, in no guaranteed order, and a login before
        // they are ready fails halfway. So bots come back a moment after the server has begun ticking.
        autoLoginIn = AUTO_LOGIN_DELAY;
    }

    private static final int AUTO_LOGIN_DELAY = 40;
    private int autoLoginIn = -1;

    private void autoLogin() {
        for (Bot b : new ArrayList<>(bots.values())) {
            if (!b.wantOnline || b.online()) continue;
            try {
                login(b, null);
            } catch (Throwable t) {
                AiPlayerMod.LOG.error("Cannot bring bot {} back online", b.name, t);
            }
        }
    }

    public void onServerStopping() {
        for (Bot b : bots.values()) {
            if (b.online()) logout(b, "server stopping", true);
        }
        save();
    }

    public void tick() {
        ServerConfigurationManager scm = MinecraftServer.getServer()
            .getConfigurationManager();
        if (autoLoginIn >= 0 && autoLoginIn-- == 0) autoLogin();
        for (Bot b : new ArrayList<>(bots.values())) {
            if (!b.online()) continue;
            String kicked = b.conn.kickReason();
            if (kicked != null) {
                // Kicked by a command or replaced by a real login with the same name: stay offline until asked.
                b.wantOnline = false;
                logout(b, kicked, false);
                continue;
            }
            try {
                b.tick(scm);
            } catch (Throwable t) {
                AiPlayerMod.LOG.error("Bot {} failed while ticking; logging it out", b.name, t);
                b.wantOnline = false;
                try {
                    logout(b, "internal error", false);
                } catch (Throwable t2) {
                    AiPlayerMod.LOG.error("Logout of bot {} failed as well", b.name, t2);
                    b.conn = null;
                }
            }
        }
        if (++ticksSinceSave >= 200 && dirty) save();
    }

    public Bot spawn(String name, Integer dim, double[] pos, JsonObject skin) {
        if (name == null || !name.matches("[^\\s/\\\\§]{1,16}")) {
            throw RpcException.badRequest("bot name must be 1-16 characters without spaces");
        }
        Bot b = find(name);
        if (b != null && b.online()) throw RpcException.badRequest("bot is already online: " + b.name);
        ServerConfigurationManager scm = MinecraftServer.getServer()
            .getConfigurationManager();
        if (scm.func_152612_a(name) != null) {
            throw RpcException.denied("a player named " + name + " is online");
        }
        if (b == null) {
            if (bots.size() >= config.maxBots) throw RpcException.denied("bot limit reached: " + config.maxBots);
            b = new Bot(this, name, offlineUuid(name));
            b.invulnerable = config.defaultInvulnerable;
            b.hunger = config.defaultHunger;
            bots.put(name.toLowerCase(), b);
        }
        if (skin != null) b.skin = skin;
        b.wantOnline = true;
        login(b, pos == null ? null : new Placement(dim, pos));
        dirty = true;
        return b;
    }

    public void despawn(Bot b) {
        b.wantOnline = false;
        if (b.online()) logout(b, "despawned", false);
        dirty = true;
    }

    private void login(Bot b, Placement where) {
        MinecraftServer server = MinecraftServer.getServer();
        ServerConfigurationManager scm = server.getConfigurationManager();
        GameProfile profile = new GameProfile(b.uuid, b.name);
        if (b.skin != null && J.has(b.skin, "value")) {
            String sig = J.str(b.skin, "signature", null);
            profile.getProperties()
                .put(
                    "textures",
                    sig == null ? new Property("textures", J.str(b.skin, "value", ""))
                        : new Property("textures", J.str(b.skin, "value", ""), sig));
        }
        if (!scm.func_152607_e(profile)) {
            // With the whitelist on, other mods (ServerUtilities) refuse to set up players that are not on it.
            scm.func_152601_d(profile);
            AiPlayerMod.LOG.info("Added bot {} to the whitelist", b.name);
        }
        EntityPlayerMP player = scm.createPlayerForUser(profile);
        BotConnection conn = new BotConnection(server, new BotNetworkManager(), player, b);
        b.conn = conn;
        try {
            scm.initializeConnectionToPlayer(conn.netManager, player, conn);
        } catch (RuntimeException e) {
            b.conn = null;
            // Do not leave a half-logged-in player behind.
            if (scm.playerEntityList.contains(player)) scm.playerLoggedOut(player);
            throw e;
        }
        if (where != null) {
            if (where.dim != null && where.dim != player.dimension) {
                scm.transferPlayerToDimension(player, where.dim);
            }
            conn.setPlayerLocation(where.pos[0], where.pos[1], where.pos[2], player.rotationYaw, 0.0F);
        }
        AiPlayerMod.LOG.info("Bot {} is online at {}, {}, {}", b.name, player.posX, player.posY, player.posZ);
        emitBot("bot.spawned", b);
    }

    private void logout(Bot b, String reason, boolean keepTasks) {
        if (keepTasks) b.tasks.suspend();
        else b.tasks.interrupt("the bot went offline: " + reason);
        BotConnection conn = b.conn;
        b.conn = null;
        b.motion.clear();
        if (conn != null) conn.onDisconnect(new ChatComponentText(reason));
        JsonObject data = new JsonObject();
        data.addProperty("bot", b.name);
        data.addProperty("reason", reason);
        bridge.emit("bot.despawned", data);
        dirty = true;
    }

    static UUID offlineUuid(String name) {
        return UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(StandardCharsets.UTF_8));
    }

    private static final class Placement {

        final Integer dim;
        final double[] pos;

        Placement(Integer dim, double[] pos) {
            this.dim = dim;
            this.pos = pos;
        }
    }

    // ---- events ---------------------------------------------------------------------------------------------

    void emitBot(String event, Bot b) {
        JsonObject data = new JsonObject();
        data.addProperty("bot", b.name);
        bridge.emit(event, data);
    }

    void emitWhisper(Bot b, String from, String message) {
        JsonObject data = new JsonObject();
        data.addProperty("bot", b.name);
        data.addProperty("from", from);
        data.addProperty("message", message);
        bridge.emit("whisper", data);
    }

    void emitBotMessage(Bot b, String text) {
        JsonObject data = new JsonObject();
        data.addProperty("bot", b.name);
        data.addProperty("text", text);
        bridge.emit("bot.message", data);
    }

    @Override
    public void onTaskUpdate(Bot bot, Task task) {
        JsonObject data = new JsonObject();
        data.addProperty("bot", bot.name);
        data.add("task", task.info());
        bridge.emit("task.update", data);
    }

    @Override
    public void onQueueChanged(Bot bot) {
        dirty = true;
    }

    public void markDirty() {
        dirty = true;
    }

    private String chatBroadcast;

    /** Remembers the text of the public chat line being sent out right now. */
    public void noteChatBroadcast(String text) {
        chatBroadcast = text;
    }

    boolean isChatBroadcast(String text) {
        return text != null && text.equals(chatBroadcast);
    }

    // ---- persistence ----------------------------------------------------------------------------------------

    private void load() {
        bots.clear();
        if (saveFile == null || !saveFile.isFile()) return;
        try {
            JsonObject root = J.parseObject(new String(Files.readAllBytes(saveFile.toPath()), StandardCharsets.UTF_8));
            JsonArray list = J.array(root, "bots");
            if (list == null) return;
            for (JsonElement e : list) {
                JsonObject o = e.getAsJsonObject();
                String name = J.reqStr(o, "name");
                Bot b = new Bot(this, name, offlineUuid(name));
                b.wantOnline = J.bool(o, "online", false);
                b.invulnerable = J.bool(o, "invulnerable", config.defaultInvulnerable);
                b.hunger = J.bool(o, "hunger", config.defaultHunger);
                b.skin = J.object(o, "skin");
                b.tasks.load(J.array(o, "tasks"));
                bots.put(name.toLowerCase(), b);
            }
        } catch (Exception e) {
            AiPlayerMod.LOG.error("Cannot read {}; starting without saved bots", saveFile, e);
        }
    }

    public void save() {
        ticksSinceSave = 0;
        dirty = false;
        if (saveFile == null) return;
        JsonArray list = new JsonArray();
        for (Bot b : bots.values()) {
            JsonObject o = new JsonObject();
            o.addProperty("name", b.name);
            o.addProperty("online", b.wantOnline);
            o.addProperty("invulnerable", b.invulnerable);
            o.addProperty("hunger", b.hunger);
            if (b.skin != null) o.add("skin", b.skin);
            o.add("tasks", b.tasks.save());
            list.add(o);
        }
        JsonObject root = new JsonObject();
        root.add("bots", list);
        try {
            saveFile.getParentFile()
                .mkdirs();
            File tmp = new File(saveFile.getPath() + ".tmp");
            String text = new GsonBuilder().setPrettyPrinting()
                .create()
                .toJson(root);
            Files.write(tmp.toPath(), text.getBytes(StandardCharsets.UTF_8));
            Files.move(tmp.toPath(), saveFile.toPath(), StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception e) {
            AiPlayerMod.LOG.error("Cannot save {}", saveFile, e);
        }
    }

    public List<JsonObject> briefs() {
        List<JsonObject> out = new ArrayList<>();
        for (Bot b : bots.values()) out.add(b.brief());
        return out;
    }
}
