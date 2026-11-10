package alu.aiplayer.bot;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.server.management.ServerConfigurationManager;
import net.minecraft.util.ChatComponentTranslation;
import net.minecraft.util.IChatComponent;
import net.minecraft.util.MathHelper;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.task.TaskQueue;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * One AI player: its identity and settings, which persist, and, while it is online, the connection that owns its
 * player entity. The entity is an ordinary EntityPlayerMP, so the server and other mods treat it as a player.
 */
public final class Bot implements BotConnection.Listener {

    /** Ticks between chat lines, keeping well under the server's spam kick threshold. */
    private static final int CHAT_INTERVAL = 22;
    private static final int RESPAWN_DELAY = 30;
    private static final int HEARD_BUFFER = 60;
    private static final int MAX_SAY_CHARS = 1000;
    private static final int MAX_QUEUED_LINES = 20;
    // The server adds 20 to a counter per chat line or command, takes 1 off per tick, and kicks above 200.
    private static final int SPAM_PER_LINE = 20;
    private static final int SPAM_ROOM_FOR_CHAT = 120;
    private static final int SPAM_ROOM_FOR_COMMAND = 160;

    public final String name;
    public final UUID uuid;
    public boolean wantOnline;
    public boolean invulnerable;
    public boolean hunger;
    public JsonObject skin;

    public final Motion motion = new Motion();
    public final TaskQueue tasks;

    private final BotManager manager;
    BotConnection conn;
    private final ArrayDeque<String> chatOut = new ArrayDeque<>();
    private int chatCooldown;
    private final ArrayDeque<Heard> heard = new ArrayDeque<>();
    private long heardSeq;
    private int spam;
    private int deadTicks;
    private long ticksOnline;

    Bot(BotManager manager, String name, UUID uuid) {
        this.manager = manager;
        this.name = name;
        this.uuid = uuid;
        this.tasks = new TaskQueue(this, manager);
    }

    public boolean online() {
        return conn != null;
    }

    /** The current player entity. It changes on respawn, so never keep it across ticks. */
    public EntityPlayerMP player() {
        return conn == null ? null : conn.playerEntity;
    }

    public BotConnection conn() {
        return conn;
    }

    public WorldServer world() {
        return (WorldServer) player().worldObj;
    }

    public BotManager manager() {
        return manager;
    }

    public long ticksOnline() {
        return ticksOnline;
    }

    // ---- per-tick driver ------------------------------------------------------------------------------------

    void tick(ServerConfigurationManager scm) {
        EntityPlayerMP p = player();
        ticksOnline++;
        if (p.getHealth() <= 0.0F || p.isDead) {
            if (deadTicks == 0) tasks.interrupt("the bot died");
            if (++deadTicks >= RESPAWN_DELAY) {
                deadTicks = 0;
                conn.respawn();
                applySettings();
                manager.emitBot("bot.spawned", this);
            }
            return;
        }
        deadTicks = 0;
        applySettings();
        conn.deliverPending();
        conn.markActive();
        conn.onNetworkTick();
        flushChat();
        tasks.tick();
        if (!online()) return; // a task or command may have logged the bot out
        p = player();
        if (p.getHealth() <= 0.0F || p.isDead) return;
        motion.apply(p);
        step(scm, p);
        motion.clear();
    }

    /** One tick of player physics, standing in for the movement packets a client would send. */
    private void step(ServerConfigurationManager scm, EntityPlayerMP p) {
        if (!conn.confirmTeleport()) {
            double ox = p.posX, oy = p.posY, oz = p.posZ;
            p.onUpdateEntity();
            if (p != player() || p.isDead) return;
            if (hunger) p.addMovementStat(p.posX - ox, p.posY - oy, p.posZ - oz);
            p.handleFalling(p.posY - oy, p.onGround);
        }
        scm.updatePlayerPertinentChunks(p);
        // Chunks queued here would be serialized for a client that does not exist.
        p.loadedChunks.clear();
    }

    private void applySettings() {
        EntityPlayerMP p = player();
        p.stepHeight = 0.5F;
        p.capabilities.disableDamage = invulnerable;
        if (!hunger && (p.getFoodStats()
            .getFoodLevel() < 20
            || p.getFoodStats()
                .getSaturationLevel() < 2.0F)) {
            NBTTagCompound tag = new NBTTagCompound();
            p.getFoodStats()
                .writeNBT(tag);
            tag.setInteger("foodLevel", 20);
            tag.setFloat("foodSaturationLevel", 5.0F);
            tag.setFloat("foodExhaustionLevel", 0.0F);
            p.getFoodStats()
                .readNBT(tag);
        }
    }

    // ---- chat -----------------------------------------------------------------------------------------------

    /** Queues text for public chat, split into lines a client could send. */
    public void say(String message) {
        if (message.length() > MAX_SAY_CHARS) message = message.substring(0, MAX_SAY_CHARS);
        for (String part : message.split("\\r?\\n")) {
            String rest = part.trim();
            while (rest.length() > 100 && chatOut.size() < MAX_QUEUED_LINES) {
                chatOut.add(rest.substring(0, 100));
                rest = rest.substring(100);
            }
            if (!rest.isEmpty() && chatOut.size() < MAX_QUEUED_LINES) chatOut.add(rest);
        }
    }

    private void flushChat() {
        if (spam > 0) spam--;
        if (chatCooldown > 0) chatCooldown--;
        if (chatCooldown == 0 && !chatOut.isEmpty() && spam <= SPAM_ROOM_FOR_CHAT) {
            spam += SPAM_PER_LINE;
            conn.sendChat(chatOut.poll());
            chatCooldown = CHAT_INTERVAL;
        }
    }

    /**
     * Runs a command as this player and returns what the server told it while doing so. Replies that arrive later
     * (after a warm-up, say) reach the brain as bot.message events.
     */
    public List<String> runCommand(String command) {
        if (!manager.config()
            .commandAllowed(command)) {
            throw RpcException.denied("command is not on the bot allow list: " + command.trim());
        }
        // The server kicks players who send too much too fast; refuse before it comes to that.
        if (spam > SPAM_ROOM_FOR_COMMAND) {
            throw RpcException.denied("too many chat lines and commands in a short time; try again in a few seconds");
        }
        long mark = heardSeq;
        if (!conn.sendCommand(command)) throw RpcException.badRequest("the command is too long for a chat line");
        spam += SPAM_PER_LINE;
        List<String> out = new ArrayList<>();
        for (Heard h : heard) if (h.seq > mark) out.add(h.text);
        return out;
    }

    @Override
    public void onMessage(IChatComponent component) {
        String text;
        try {
            text = component.getUnformattedText();
        } catch (Throwable t) {
            return;
        }
        if (component instanceof ChatComponentTranslation) {
            ChatComponentTranslation tr = (ChatComponentTranslation) component;
            String key = tr.getKey();
            // Public chat reaches the brain as a chat event already.
            if ("chat.type.text".equals(key) || "chat.type.announcement".equals(key)) return;
            // Comings and goings are player.join / player.leave events.
            if (key.startsWith("multiplayer.player.")) return;
            if ("commands.message.display.incoming".equals(key)) {
                Object[] args = tr.getFormatArgs();
                if (args.length >= 2) {
                    manager.emitWhisper(this, text(args[0]), text(args[1]));
                    return;
                }
            }
        }
        if (text == null || text.trim()
            .isEmpty() || manager.isChatBroadcast(text)) return;
        heard.addLast(new Heard(++heardSeq, text));
        while (heard.size() > HEARD_BUFFER) heard.removeFirst();
        manager.emitBotMessage(this, text);
    }

    private static String text(Object o) {
        return o instanceof IChatComponent ? ((IChatComponent) o).getUnformattedText() : String.valueOf(o);
    }

    // ---- climbing blocks ----------------------------------------------------------------------------------------

    private static final int SCAFFOLD_MEMORY = 512;
    private final java.util.LinkedHashSet<Long> scaffold = new java.util.LinkedHashSet<>();
    private final java.util.Set<Long> scaffoldView = java.util.Collections.unmodifiableSet(scaffold);
    private long scaffoldCount;

    /** Remembers a block this bot put down only to stand on. */
    public void noteScaffold(int x, int y, int z) {
        scaffold.add(alu.aiplayer.nav.NavWorld.key(x, y, z));
        scaffoldCount++;
        if (scaffold.size() > SCAFFOLD_MEMORY) {
            java.util.Iterator<Long> it = scaffold.iterator();
            it.next();
            it.remove();
        }
    }

    /** Cells where this bot has placed climbing blocks that may still be standing. */
    public java.util.Set<Long> scaffoldCells() {
        return scaffoldView;
    }

    public void forgetScaffold(int x, int y, int z) {
        scaffold.remove(alu.aiplayer.nav.NavWorld.key(x, y, z));
    }

    // ---- interaction results ----------------------------------------------------------------------------------

    private int clickX, clickY, clickZ;
    private boolean clickRefused;
    private long clickTick = -1;

    /** Called for each right-click on a block this bot makes, with whether something refused it. */
    public void noteInteraction(int x, int y, int z, boolean refused) {
        clickX = x;
        clickY = y;
        clickZ = z;
        clickRefused = refused;
        clickTick = ticksOnline;
    }

    /** Whether this bot's most recent click on that block, within the last few ticks, was refused. */
    public boolean clickWasRefused(int x, int y, int z) {
        return clickRefused && clickX == x && clickY == y && clickZ == z && ticksOnline - clickTick <= 10;
    }

    private long placeRefusedTick = -1;

    public void notePlacementRefused() {
        placeRefusedTick = ticksOnline;
    }

    /** Whether, this tick, a block this bot tried to place or a click it made to place one was refused. */
    public boolean placementWasRefused() {
        return placeRefusedTick == ticksOnline || (clickRefused && clickTick == ticksOnline);
    }

    // ---- description ----------------------------------------------------------------------------------------

    public JsonObject brief() {
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        o.addProperty("online", online());
        if (online()) {
            EntityPlayerMP p = player();
            o.addProperty("dim", p.dimension);
            o.add("block", J.pos(blockX(), blockY(), blockZ()));
            o.add("task", tasks.activeInfo());
        }
        return o;
    }

    public JsonObject status() {
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        o.addProperty("uuid", uuid.toString());
        o.addProperty("online", online());
        JsonObject settings = new JsonObject();
        settings.addProperty("invulnerable", invulnerable);
        settings.addProperty("hunger", hunger);
        o.add("settings", settings);
        o.add("task", tasks.activeInfo());
        o.add("queue", tasks.queueInfo());
        if (!online()) return o;
        EntityPlayerMP p = player();
        o.addProperty("dim", p.dimension);
        o.add("pos", J.pos(p.posX, p.posY, p.posZ));
        o.add("block", J.pos(blockX(), blockY(), blockZ()));
        o.addProperty("yaw", J.round(MathHelper.wrapAngleTo180_float(p.rotationYaw)));
        o.addProperty("pitch", J.round(p.rotationPitch));
        o.addProperty("onGround", p.onGround);
        o.addProperty("inWater", p.isInWater());
        o.addProperty("health", J.round(p.getHealth()));
        o.addProperty("maxHealth", J.round(p.getMaxHealth()));
        o.addProperty(
            "food",
            p.getFoodStats()
                .getFoodLevel());
        o.addProperty("xpLevel", p.experienceLevel);
        o.addProperty("heldSlot", p.inventory.currentItem);
        ItemStack held = p.inventory.getCurrentItem();
        o.add("held", held == null ? JsonNull.INSTANCE : Names.describe(held));
        JsonArray inv = new JsonArray();
        int free = 0;
        for (int i = 0; i < p.inventory.mainInventory.length; i++) {
            ItemStack s = p.inventory.mainInventory[i];
            if (s == null) {
                free++;
                continue;
            }
            JsonObject item = Names.describe(s);
            item.addProperty("slot", i);
            inv.add(item);
        }
        o.add("inventory", inv);
        o.addProperty("freeSlots", free);
        JsonArray armor = new JsonArray();
        for (ItemStack s : p.inventory.armorInventory) armor.add(s == null ? JsonNull.INSTANCE : Names.describe(s));
        o.add("armor", armor);
        return o;
    }

    public int blockX() {
        return MathHelper.floor_double(player().posX);
    }

    /** The cell the feet are in. The small offset keeps a bot standing exactly on a block top in the cell above. */
    public int blockY() {
        return MathHelper.floor_double(player().posY + 0.01);
    }

    public int blockZ() {
        return MathHelper.floor_double(player().posZ);
    }

    private static final class Heard {

        final long seq;
        final String text;

        Heard(long seq, String text) {
            this.seq = seq;
            this.text = text;
        }
    }
}
