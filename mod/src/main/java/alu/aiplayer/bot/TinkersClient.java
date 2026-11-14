package alu.aiplayer.bot;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;

import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.Names;

/** StencilTableGui's pattern buttons, through its native PatternTablePacket server handler. */
final class TinkersClient implements ModClient {

    private final Class<?> plain = Class.forName("tconstruct.tools.inventory.PatternShaperContainer");
    private final Class<?> chest = Class.forName("tconstruct.tools.inventory.PatternShaperChestContainer");
    private final Class<?> builder = Class.forName("tconstruct.library.crafting.StencilBuilder");
    private final Class<?> packet = Class.forName("tconstruct.util.network.PatternTablePacket");
    private final Method blank = builder.getMethod("isBlank", ItemStack.class);

    TinkersClient() throws ReflectiveOperationException {}

    private boolean matches(Container c) {
        return plain.isInstance(c) || chest.isInstance(c);
    }

    @SuppressWarnings("unchecked")
    private Map<Integer, ItemStack> patterns() throws ReflectiveOperationException {
        return (Map<Integer, ItemStack>) builder.getField("stencils").get(builder.getField("instance").get(null));
    }

    @Override
    public void controls(Container c, JsonArray out) {
        if (!matches(c)) return;
        try {
            for (Map.Entry<Integer, ItemStack> e : patterns().entrySet()) {
                JsonObject o = new JsonObject();
                o.addProperty("key", "stencil:" + e.getKey());
                o.addProperty("kind", "button");
                ItemStack s = e.getValue();
                o.addProperty("label", Names.displayName(s) + " [" + Names.itemId(s.getItem()) + "/" + s.getItemDamage() + "]");
                out.add(o);
            }
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public boolean pressControl(Bot bot, Container c, String key) {
        if (!matches(c) || !key.startsWith("stencil:")) return false;
        try {
            if (!c.canInteractWith(bot.player())) throw RpcException.denied("the stencil table is no longer within reach");
            ItemStack input = c.getSlot(0).getStack();
            if (input == null || !(Boolean) blank.invoke(null, input)) {
                throw new RpcException("invalid", "put a blank pattern in slot 0 before selecting its shape");
            }
            int id;
            try {
                id = Integer.parseInt(key.substring("stencil:".length()));
            } catch (NumberFormatException e) {
                throw RpcException.badRequest("choose a listed stencil button");
            }
            ItemStack selected = patterns().get(id);
            if (selected == null) throw RpcException.badRequest("choose a listed stencil button");
            TileEntity logic = (TileEntity) c.getClass().getField("logic").get(c);
            // The GUI sends this same registered pattern and table position. The mod's handler validates
            // the open container and position, then its recipe logic updates the preview. Taking the
            // output remains a normal slot click, which consumes the blank pattern.
            Object message = packet.getConstructor(int.class, int.class, int.class, ItemStack.class)
                .newInstance(logic.xCoord, logic.yCoord, logic.zCoord, selected.copy());
            packet.getMethod("handleServerSide", EntityPlayer.class).invoke(message, bot.player());
            c.detectAndSendChanges();
            return true;
        } catch (ReflectiveOperationException e) {
            throw new RpcException("invalid", "the stencil table did not take that selection: " + e);
        }
    }

    @Override public void keys(JsonArray out) {}
    @Override public boolean press(Bot bot, String key) { return false; }
    @Override public void usedInAir(BotConnection conn, ItemStack held) {}
    @Override public void tick(Bot bot, EntityPlayerMP p) {}
    @Override public void worn(EntityPlayerMP p, List<Worn> out) {}
}
