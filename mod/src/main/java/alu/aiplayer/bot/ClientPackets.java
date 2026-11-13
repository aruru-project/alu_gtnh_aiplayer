package alu.aiplayer.bot;

import java.io.IOException;

import net.minecraft.item.ItemStack;
import net.minecraft.network.Packet;
import net.minecraft.network.PacketBuffer;
import net.minecraft.network.play.client.C02PacketUseEntity;
import net.minecraft.network.play.client.C03PacketPlayer;
import net.minecraft.network.play.client.C07PacketPlayerDigging;
import net.minecraft.network.play.client.C08PacketPlayerBlockPlacement;
import net.minecraft.network.play.client.C09PacketHeldItemChange;
import net.minecraft.network.play.client.C0APacketAnimation;
import net.minecraft.network.play.client.C0DPacketCloseWindow;

import io.netty.buffer.Unpooled;

/**
 * Builds the packets a real client would send. Their value constructors are client-only and do not exist on a
 * dedicated server, so each packet is filled by decoding the same bytes a client puts on the wire.
 */
final class ClientPackets {

    private ClientPackets() {}

    static final int DIG_START = 0;
    static final int DIG_ABORT = 1;
    static final int DIG_FINISH = 2;

    static C07PacketPlayerDigging digging(int status, int x, int y, int z, int face) {
        PacketBuffer b = buffer();
        b.writeByte(status);
        b.writeInt(x);
        b.writeByte(y);
        b.writeInt(z);
        b.writeByte(face);
        return read(new C07PacketPlayerDigging(), b);
    }

    /** side 255 means "use the held item in the air" (eat, throw…). */
    static C08PacketPlayerBlockPlacement placement(int x, int y, int z, int side, ItemStack held, float hitX,
        float hitY, float hitZ) {
        PacketBuffer b = buffer();
        b.writeInt(x);
        b.writeByte(y);
        b.writeInt(z);
        b.writeByte(side);
        try {
            b.writeItemStackToBuffer(held);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        b.writeByte((int) (hitX * 16.0F));
        b.writeByte((int) (hitY * 16.0F));
        b.writeByte((int) (hitZ * 16.0F));
        return read(new C08PacketPlayerBlockPlacement(), b);
    }

    static C03PacketPlayer.C06PacketPlayerPosLook posLook(double x, double feetY, double z, float yaw, float pitch,
        boolean onGround) {
        PacketBuffer b = buffer();
        b.writeDouble(x);
        b.writeDouble(feetY);
        b.writeDouble(feetY + 1.62D);
        b.writeDouble(z);
        b.writeFloat(yaw);
        b.writeFloat(pitch);
        b.writeByte(onGround ? 1 : 0);
        return read(new C03PacketPlayer.C06PacketPlayerPosLook(), b);
    }

    static C02PacketUseEntity entity(int id, boolean left) {
        PacketBuffer b = buffer();
        b.writeInt(id);
        b.writeByte(left ? 1 : 0);
        return read(new C02PacketUseEntity(), b);
    }

    static C09PacketHeldItemChange heldItem(int slot) {
        PacketBuffer b = buffer();
        b.writeShort(slot);
        return read(new C09PacketHeldItemChange(), b);
    }

    static C0APacketAnimation swing(int entityId) {
        PacketBuffer b = buffer();
        b.writeInt(entityId);
        b.writeByte(1);
        return read(new C0APacketAnimation(), b);
    }

    static C0DPacketCloseWindow closeWindow(int windowId) {
        PacketBuffer b = buffer();
        b.writeByte(windowId);
        return read(new C0DPacketCloseWindow(), b);
    }

    private static PacketBuffer buffer() {
        return new PacketBuffer(Unpooled.buffer(64));
    }

    private static <T extends Packet> T read(T packet, PacketBuffer data) {
        try {
            packet.readPacketData(data);
        } catch (IOException e) {
            throw new IllegalStateException("cannot build " + packet.getClass().getSimpleName(), e);
        }
        return packet;
    }
}
