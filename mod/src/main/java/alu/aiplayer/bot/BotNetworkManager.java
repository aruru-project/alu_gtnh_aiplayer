package alu.aiplayer.bot;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketAddress;

import net.minecraft.network.EnumConnectionState;
import net.minecraft.network.NetworkManager;
import net.minecraft.network.Packet;

import io.netty.channel.ChannelDuplexHandler;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelOutboundHandlerAdapter;
import io.netty.channel.ChannelPromise;
import io.netty.channel.ChannelPipeline;
import io.netty.channel.embedded.EmbeddedChannel;
import io.netty.util.ReferenceCountUtil;
import io.netty.util.concurrent.GenericFutureListener;

/**
 * The connection of a player that has no client. It owns an open in-memory channel, because server and mod code
 * reads {@code channel()} of every player, and it discards everything sent to it.
 */
public final class BotNetworkManager extends NetworkManager {

    private static final String[] PIPELINE_NAMES = { "timeout", "splitter", "decoder", "prepender", "encoder" };
    private static final SocketAddress LOOPBACK = new InetSocketAddress(InetAddress.getLoopbackAddress(), 0);

    public BotNetworkManager() {
        super(false);
        // First in the pipeline is last on the way out: anything written straight to the channel ends here
        // instead of collecting in the embedded channel's outbound queue.
        EmbeddedChannel channel = new EmbeddedChannel(new ChannelOutboundHandlerAdapter() {

            @Override
            public void write(ChannelHandlerContext ctx, Object msg, ChannelPromise promise) {
                ReferenceCountUtil.release(msg);
                promise.setSuccess();
            }
        });
        ChannelPipeline pipeline = channel.pipeline();
        // Mods insert their own handlers relative to the names of a real connection's pipeline.
        for (String name : PIPELINE_NAMES) pipeline.addLast(name, new ChannelDuplexHandler());
        pipeline.addLast("packet_handler", this);
        try {
            // Stores the channel in the superclass, as the activation of a real connection would.
            channelActive(pipeline.context(this));
        } catch (Exception e) {
            throw new IllegalStateException("cannot set up the bot connection", e);
        }
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
