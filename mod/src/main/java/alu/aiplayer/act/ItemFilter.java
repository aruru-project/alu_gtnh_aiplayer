package alu.aiplayer.act;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/** Matches item stacks by registry name and, optionally, meta; may carry a wanted count. */
public final class ItemFilter {

    public final String id;
    public final Item item;
    /** -1 matches any meta. */
    public final int meta;
    /** -1 means "as many as there are". */
    public final int count;

    public ItemFilter(String id, int meta, int count) {
        this.id = id;
        this.item = Names.item(id);
        if (item == null) throw RpcException.badRequest("unknown item id: " + id);
        this.meta = meta;
        this.count = count;
    }

    public static ItemFilter parse(JsonObject o) {
        return new ItemFilter(J.reqStr(o, "id"), J.i(o, "meta", -1), J.i(o, "count", -1));
    }

    public boolean matches(ItemStack stack) {
        return stack != null && stack.getItem() == item && (meta < 0 || Names.meta(stack) == meta);
    }

    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        if (meta >= 0) o.addProperty("meta", meta);
        if (count >= 0) o.addProperty("count", count);
        return o;
    }
}
