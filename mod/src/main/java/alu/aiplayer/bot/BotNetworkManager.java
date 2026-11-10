package alu.aiplayer.bot;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketAddress;

import net.minecraft.network.EnumConnectionState;
import net.minecraft.network.NetworkManager;
import net.minecraft.network.Packet;

import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.util.concurrent.GenericFutureListener;

/**
 * The connection of a player that has no client. It owns an open in-memory channel, because server and mod code
 * reads {@code channel()} of every player, and it discards everything sent to it.
 */
public final class BotNetworkManager extends NetworkManager {

    private static final SocketAddress LOOPBACK = new InetSocketAddress(InetAddress.getLoopbackAddress(), 0);

    public BotNetworkManager() {
        super(false);
        // Registering the handler fires channelActive, which stores the channel in the superclass.
        new EmbeddedChannel(this);
        if (channel() == null) throw new IllegalStateException("embedded channel did not activate");
        setConnectionState(EnumConnectionState.PLAY);
    }

    @Override
    public void scheduleOutboundPacket(Packet packet, GenericFutureListener... listeners) {
        // Nobody is listening. Dropping here keeps packets from piling up in the embedded channel.
    }

    @Override
    public SocketAddress getSocketAddress() {
        // Code that logs or parses player addresses expects "host/ip:port".
        return LOOPBACK;
    }

    @Override
    public void processReceivedPackets() {}
}
