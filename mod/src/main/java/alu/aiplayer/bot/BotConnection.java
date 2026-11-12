package alu.aiplayer.bot;

import java.lang.reflect.Field;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.network.NetHandlerPlayServer;
import net.minecraft.network.Packet;
import net.minecraft.network.play.client.C01PacketChatMessage;
import net.minecraft.network.play.client.C16PacketClientStatus;
import net.minecraft.network.play.server.S02PacketChat;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.ChatAllowedCharacters;
import net.minecraft.util.IChatComponent;

import alu.aiplayer.AiPlayerMod;

/**
 * The server-side end of a bot's "connection". Everything the bot does to the world goes in through the same
 * packet handlers a real client reaches, so vanilla checks and other mods' hooks apply unchanged. Packets going
 * out to the nonexistent client are dropped, except chat, which is how the bot hears command replies and whispers.
 */
public final class BotConnection extends NetHandlerPlayServer {

    public interface Listener {

        void onMessage(IChatComponent component);
    }

    private static final Field CHAT_COMPONENT = findChatField();

    private final Listener listener;
    private final Thread owner = Thread.currentThread();
    private final java.util.concurrent.ConcurrentLinkedQueue<IChatComponent> offThread = new java.util.concurrent.ConcurrentLinkedQueue<>();
    private volatile String kickReason;
    private boolean teleported;
    private int teleports;
    private double teleX, teleY, teleZ;

    public BotConnection(MinecraftServer server, BotNetworkManager manager, EntityPlayerMP player,
        Listener listener) {
        super(server, manager, player);
        this.listener = listener;
    }

    @Override
    public void sendPacket(Packet packet) {
        if (packet instanceof S02PacketChat && CHAT_COMPONENT != null && listener != null) {
            try {
                IChatComponent c = (IChatComponent) CHAT_COMPONENT.get(packet);
                if (c == null) return;
                // Other mods may message players from their own threads; those wait for the next tick.
                if (Thread.currentThread() == owner) listener.onMessage(c);
                else offThread.add(c);
            } catch (Exception e) {
                AiPlayerMod.LOG.debug("Cannot read chat packet", e);
            }
        }
    }

    /** A kick cannot travel to a client that does not exist; the manager logs the bot out on its next tick. */
    @Override
    public void kickPlayerFromServer(String reason) {
        if (kickReason == null) kickReason = reason == null ? "kicked" : reason;
    }

    /** Hands over messages that arrived from other threads. Call from the server thread. */
    public void deliverPending() {
        IChatComponent c;
        while ((c = offThread.poll()) != null) listener.onMessage(c);
    }

    public String kickReason() {
        if (kickReason == null && !netManager.isChannelOpen()) kickReason = "connection closed";
        return kickReason;
    }

    @Override
    public void setPlayerLocation(double x, double y, double z, float yaw, float pitch) {
        super.setPlayerLocation(x, y, z, yaw, pitch);
        teleported = true;
        teleports++;
        teleX = x;
        teleY = y;
        teleZ = z;
    }

    /**
     * After a teleport the server ignores block interaction until the client echoes the new position. Returns true
     * when it did so; that call also runs this tick's movement.
     */
    public boolean confirmTeleport() {
        if (!teleported) return false;
        teleported = false;
        EntityPlayerMP p = playerEntity;
        processPlayer(ClientPackets.posLook(teleX, teleY, teleZ, p.rotationYaw, p.rotationPitch, p.onGround));
        return true;
    }

    public boolean teleportPending() {
        return teleported;
    }

    /** How many times the server has moved this player by teleport since it logged in. */
    public int teleportCount() {
        return teleports;
    }

    /**
     * Says one line in public chat. The text is never run as a command, whatever it looks like: once the characters
     * the server would refuse are replaced, every leading slash and blank is dropped.
     */
    public void sendChat(String line) {
        String text = clean(line);
        int start = 0;
        while (start < text.length() && (text.charAt(start) == '/' || Character.isWhitespace(text.charAt(start)))) {
            start++;
        }
        text = text.substring(start);
        if (text.length() > 100) text = text.substring(0, 100);
        if (text.isEmpty()) return;
        processChatMessage(new C01PacketChatMessage(text));
    }

    /** Runs a command (given without the slash) as this player. Returns false if it does not fit in a chat line. */
    public boolean sendCommand(String command) {
        String text = "/" + clean(command);
        if (text.length() < 2 || text.length() > 100) return false;
        processChatMessage(new C01PacketChatMessage(text));
        return true;
    }

    /** Replaces characters the server kicks for and trims, as the chat handler itself will. */
    private static String clean(String line) {
        StringBuilder sb = new StringBuilder(line.length());
        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            sb.append(ChatAllowedCharacters.isAllowedCharacter(ch) ? ch : ' ');
        }
        return org.apache.commons.lang3.StringUtils.normalizeSpace(sb.toString());
    }

    public void startDigging(int x, int y, int z, int face) {
        processPlayerDigging(ClientPackets.digging(ClientPackets.DIG_START, x, y, z, face));
    }

    public void finishDigging(int x, int y, int z, int face) {
        processPlayerDigging(ClientPackets.digging(ClientPackets.DIG_FINISH, x, y, z, face));
    }

    public void abortDigging(int x, int y, int z, int face) {
        processPlayerDigging(ClientPackets.digging(ClientPackets.DIG_ABORT, x, y, z, face));
    }

    /** Right-clicks a block face with the held item: places a block or activates the clicked block. */
    public void useOnBlock(int x, int y, int z, int side, float hitX, float hitY, float hitZ) {
        ItemStack held = playerEntity.inventory.getCurrentItem();
        processPlayerBlockPlacement(ClientPackets.placement(x, y, z, side, held, hitX, hitY, hitZ));
    }

    /**
     * Right-clicks with the held item in the air (eat, drink…), and does the part of it that some mods' items do in
     * the client (asking the server for their screen, say).
     */
    public void useItem() {
        ItemStack held = playerEntity.inventory.getCurrentItem();
        processPlayerBlockPlacement(ClientPackets.placement(-1, 255, -1, 255, held, 0, 0, 0));
        ModClients.usedInAir(this, held);
    }

    public void selectHotbar(int slot) {
        if (playerEntity.inventory.currentItem != slot) processHeldItemChange(ClientPackets.heldItem(slot));
    }

    public void swingArm() {
        processAnimation(ClientPackets.swing(playerEntity.getEntityId()));
    }

    public void closeWindow() {
        processCloseWindow(ClientPackets.closeWindow(playerEntity.openContainer.windowId));
    }

    /** Counts as player activity, so a configured idle timeout does not kick a bot that is busy. */
    public void markActive() {
        playerEntity.func_143004_u();
    }

    /** Asks for a respawn after death. The server replaces {@link #playerEntity} with a new entity. */
    public void respawn() {
        processClientStatus(new C16PacketClientStatus(C16PacketClientStatus.EnumState.PERFORM_RESPAWN));
    }

    private static Field findChatField() {
        try {
            for (Field f : S02PacketChat.class.getDeclaredFields()) {
                if (IChatComponent.class.isAssignableFrom(f.getType())) {
                    f.setAccessible(true);
                    return f;
                }
            }
        } catch (Exception e) {
            AiPlayerMod.LOG.warn("Cannot access chat packets; bots will not hear command replies", e);
        }
        return null;
    }
}
