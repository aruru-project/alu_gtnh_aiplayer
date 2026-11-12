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

import alu.aiplayer.act.Inventories;
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
        closeDoorsBehind(p);
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

    private static final int CHAT_LINE = 100;
    private static final String BREAK_AFTER = "\u3002\uff01\uff1f\uff1b\uff0c\u3001\uff1a\uff09,.!?;:) ";

    /**
     * Queues text for public chat, split into lines a client could send. A long text is broken after punctuation
     * or a space where there is one in the last part of a line, so that no line stops in the middle of a word.
     * Returns {lines queued, lines dropped because the queue was full, characters cut off the end}.
     */
    public int[] say(String message) {
        int cut = Math.max(0, message.length() - MAX_SAY_CHARS);
        if (cut > 0) message = message.substring(0, MAX_SAY_CHARS);
        int queued = 0, dropped = 0;
        for (String part : message.split("\\r?\\n")) {
            String rest = part.trim();
            while (!rest.isEmpty()) {
                int end = rest.length();
                if (end > CHAT_LINE) {
                    end = CHAT_LINE;
                    for (int i = CHAT_LINE; i > CHAT_LINE * 6 / 10; i--) {
                        if (BREAK_AFTER.indexOf(rest.charAt(i - 1)) >= 0) {
                            end = i;
                            break;
                        }
                    }
                    if (Character.isHighSurrogate(rest.charAt(end - 1))) end--;
                }
                String line = rest.substring(0, end)
                    .trim();
                rest = rest.substring(end)
                    .trim();
                if (line.isEmpty()) continue;
                if (chatOut.size() < MAX_QUEUED_LINES) {
                    chatOut.add(line);
                    queued++;
                } else {
                    dropped++;
                }
            }
        }
        return new int[] { queued, dropped, cut };
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
        long mark = heardMark();
        if (!conn.sendCommand(command)) throw RpcException.badRequest("the command is too long for a chat line");
        spam += SPAM_PER_LINE;
        return heardSince(mark);
    }

    /** A mark in what this bot has been told, for {@link #heardSince}. */
    public long heardMark() {
        return heardSeq;
    }

    /** The lines the server and mods told this bot since the mark: what doing something made the game say. */
    public List<String> heardSince(long mark) {
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

    // ---- doors ---------------------------------------------------------------------------------------------

    private final java.util.Map<Long, Long> shutDoors = new java.util.HashMap<>();
    private final java.util.Set<Long> shutDoorView = java.util.Collections.unmodifiableSet(shutDoors.keySet());
    private final java.util.List<int[]> openedDoors = new java.util.ArrayList<>();

    /** Doors that would not open for this bot. Forgotten after a few minutes, in case someone unlocks them. */
    public java.util.Set<Long> shutDoors() {
        return shutDoorView;
    }

    public void noteShutDoor(int x, int y, int z) {
        if (shutDoors.size() > 256) shutDoors.clear();
        shutDoors.put(alu.aiplayer.nav.NavWorld.key(x, y, z), ticksOnline);
    }

    public void noteOpenedDoor(int x, int y, int z) {
        for (int[] d : openedDoors) if (d[0] == x && d[1] == y && d[2] == z) return;
        if (openedDoors.size() < 16) openedDoors.add(new int[] { x, y, z });
    }

    /** Shuts the doors this bot opened once it has walked on, as a person would pull one to behind them. */
    private void closeDoorsBehind(EntityPlayerMP p) {
        if (shutDoors.size() > 0 && ticksOnline % 200 == 0) {
            for (java.util.Iterator<Long> it = shutDoors.values()
                .iterator(); it.hasNext();) if (ticksOnline - it.next() > 20 * 300) it.remove();
        }
        if (openedDoors.isEmpty() || ticksOnline % 5 != 0) return;
        for (java.util.Iterator<int[]> it = openedDoors.iterator(); it.hasNext();) {
            int[] d = it.next();
            double dx = p.posX - (d[0] + 0.5), dz = p.posZ - (d[2] + 0.5);
            double flat = dx * dx + dz * dz;
            if (flat < 2.6 * 2.6) continue; // still in or right by the doorway
            it.remove();
            net.minecraft.world.World w = p.worldObj;
            if (!w.blockExists(d[0], d[1], d[2])) continue;
            net.minecraft.block.Block b = w.getBlock(d[0], d[1], d[2]);
            if (alu.aiplayer.act.Doors.state(w, d[0], d[1], d[2], b) != alu.aiplayer.act.Doors.OPEN) continue;
            if (!alu.aiplayer.act.Reach.canReach(p, d[0], d[1], d[2])) continue;
            alu.aiplayer.act.ContainerSession.clickEmptyHanded(this, d[0], d[1], d[2]);
            // One click moves the whole door; its other cells need no click of their own.
            for (java.util.Iterator<int[]> rest = openedDoors.iterator(); rest.hasNext();) {
                int[] o = rest.next();
                if (Math.abs(o[0] - d[0]) + Math.abs(o[1] - d[1]) + Math.abs(o[2] - d[2]) <= 4) rest.remove();
            }
            return;
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

    private int punchX, punchY, punchZ;
    private boolean punchRefused;
    private long punchTick = -1;

    /** Called for each left-click on a block this bot makes, with whether something refused it. */
    public void notePunch(int x, int y, int z, boolean refused) {
        punchX = x;
        punchY = y;
        punchZ = z;
        punchRefused = refused;
        punchTick = ticksOnline;
    }

    /** Whether this bot's most recent left-click on that block, within the last few ticks, was refused. */
    public boolean punchWasRefused(int x, int y, int z) {
        return punchRefused && punchX == x && punchY == y && punchZ == z && ticksOnline - punchTick <= 10;
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
                if (i < Inventories.CARRY_SLOTS) free++;
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
        // Worn somewhere other mods keep, outside the armor slots (a pack on the back), with the tanks it shows.
        JsonArray worn = ModClients.worn(p);
        if (worn.size() > 0) o.add("worn", worn);
        double above = aboveGround(p);
        if (above >= 0) o.addProperty("aboveGround", J.round(above));
        o.add("motion", moved(p));
        return o;
    }

    /**
     * How far the player moved in its last tick, in blocks: what a player sees of its own speed. (The game's motion
     * vector is not that: it holds this tick's gravity even while something keeps the player hovering in place.)
     */
    public static JsonObject moved(EntityPlayerMP p) {
        return J.pos(p.posX - p.prevPosX, p.posY - p.prevPosY, p.posZ - p.prevPosZ);
    }

    /**
     * How far the feet are above what is under them: the first block below that stops a fall, or a liquid's surface,
     * in the column the player stands in. 0 standing on the ground; -1 when nothing is there within 256 blocks or that
     * part of the world is not loaded.
     */
    public static double aboveGround(EntityPlayerMP p) {
        if (p.onGround) return 0;
        net.minecraft.world.World w = p.worldObj;
        int x = MathHelper.floor_double(p.posX), z = MathHelper.floor_double(p.posZ);
        int top = MathHelper.floor_double(p.posY);
        for (int y = top; y >= Math.max(0, top - 256); y--) {
            if (!w.blockExists(x, y, z)) return -1;
            net.minecraft.block.Block b = w.getBlock(x, y, z);
            if (b.getMaterial()
                .isLiquid()) return Math.max(0, p.posY - (y + 1));
            net.minecraft.util.AxisAlignedBB box = b.getCollisionBoundingBoxFromPool(w, x, y, z);
            if (box != null && box.maxY <= p.posY + 1.0e-6) return p.posY - box.maxY;
        }
        return -1;
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
