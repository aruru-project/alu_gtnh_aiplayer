package alu.aiplayer.act;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Map;

import net.minecraft.inventory.Container;
import net.minecraft.network.PacketBuffer;
import net.minecraftforge.fluids.FluidStack;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;
import io.netty.buffer.Unpooled;

/**
 * What a screen has besides slots: its switches, numbers, choices, the further panels it can open, its fluid
 * slots, its buttons. A player works these with the mouse; a screen built on ModularUI 2 keeps, on the server,
 * one named handler for each thing a player can change, and this lists those and works them as the player's
 * client would. Nothing here knows what any one screen is for: the names are the screen's own.
 * <p>
 * Reached by reflection; a screen of another kind simply has no controls here.
 */
public final class Controls {

    private Controls() {}

    private static final String PKG = "com.cleanroommc.modularui.";

    private static Class<?> cls(String name) {
        try {
            return Class.forName(PKG + name);
        } catch (Throwable t) {
            return null;
        }
    }

    private static Object field(Object o, String name) throws Exception {
        for (Class<?> c = o.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(o);
            } catch (NoSuchFieldException ignored) {}
        }
        throw new NoSuchFieldException(name);
    }

    private static Object call(Object o, String name) throws Exception {
        Method m = o.getClass()
            .getMethod(name);
        m.setAccessible(true);
        return m.invoke(o);
    }

    /** The panels of an open screen and the handlers of each, or null when it is not such a screen. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> panels(Container c) {
        Class<?> container = cls("screen.ModularContainer");
        if (container == null || !container.isInstance(c)) return null;
        try {
            Object manager = call(c, "getSyncManager");
            if (manager == null) return null;
            return (Map<String, Object>) field(manager, "panelSyncManagerMap");
        } catch (Throwable t) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> handlers(Object panel) throws Exception {
        return (Map<String, Object>) field(panel, "syncHandlers");
    }

    private static boolean is(Object o, String name) {
        Class<?> c = cls(name);
        return c != null && c.isInstance(o);
    }

    /** [{panel, key, kind, value?, …}] for every control of the open screen; empty for a screen without any. */
    public static JsonArray list(Container c) {
        JsonArray out = new JsonArray();
        Map<String, Object> panels = panels(c);
        if (panels == null) return out;
        for (Map.Entry<String, Object> p : panels.entrySet()) {
            try {
                for (Map.Entry<String, Object> h : handlers(p.getValue()).entrySet()) {
                    JsonObject o = describe(h.getValue());
                    if (o == null) continue;
                    JsonObject j = new JsonObject();
                    j.addProperty("panel", p.getKey());
                    j.addProperty("key", h.getKey());
                    for (Map.Entry<String, JsonElement> e : o.entrySet()) j.add(e.getKey(), e.getValue());
                    out.add(j);
                    if (out.size() >= 200) return out;
                }
            } catch (Throwable ignored) {}
        }
        return out;
    }

    /** GregTech's programmed-circuit setting: a ghost slot the player picks a number for. */
    private static boolean isCircuit(Object h) {
        try {
            h.getClass()
                .getMethod("getGhostCircuitHandler");
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    private static JsonObject describe(Object h) {
        if (isCircuit(h)) {
            JsonObject o = new JsonObject();
            o.addProperty("kind", "circuit");
            try {
                int n = (Integer) call(call(h, "getGhostCircuitHandler"), "getCircuitConfig");
                o.addProperty("value", n < 0 ? 0 : n);
            } catch (Throwable t) {
                o.addProperty("unreadable", true);
            }
            o.addProperty("range", "0 (none) or 1-24");
            return o;
        }
        // Item slots are the screen's slots already; the cursor is the bot's own hand.
        if (is(h, "value.sync.ItemSlotSH") || is(h, "value.sync.CursorSlotSyncHandler")) return null;
        JsonObject o = new JsonObject();
        try {
            if (is(h, "value.sync.PanelSyncHandler")) {
                o.addProperty("kind", "panel");
                o.addProperty("open", (Boolean) call(h, "isPanelOpen"));
                return o;
            }
            if (is(h, "value.sync.FluidSlotSyncHandler")) {
                o.addProperty("kind", "fluid");
                FluidStack f = (FluidStack) call(h, "getValue");
                if (f != null && f.getFluid() != null && f.amount > 0) {
                    o.addProperty("fluid", f.getFluid().getName());
                    o.addProperty("name", f.getLocalizedName());
                    o.addProperty("amount", f.amount);
                } else {
                    o.addProperty("amount", 0);
                }
                try {
                    Object tank = call(h, "getFluidTank");
                    o.addProperty("capacity", ((net.minecraftforge.fluids.IFluidTank) tank).getCapacity());
                } catch (Throwable ignored) {}
                o.addProperty("fills", (Boolean) call(h, "canFillSlot"));
                o.addProperty("drains", (Boolean) call(h, "canDrainSlot"));
                if ((Boolean) call(h, "isPhantom")) o.addProperty("phantom", true);
                return o;
            }
            if (is(h, "value.sync.InteractionSyncHandler")) {
                o.addProperty("kind", "button");
                return o;
            }
            if (is(h, "value.sync.EnumSyncValue")) {
                o.addProperty("kind", "choice");
                Object v = call(h, "getValue");
                o.addProperty("value", String.valueOf(v));
                JsonArray options = new JsonArray();
                Object[] all = ((Class<?>) call(h, "getEnumClass")).getEnumConstants();
                if (all != null) for (Object e : all) if (options.size() < 40) options.add(new com.google.gson.JsonPrimitive(String.valueOf(e)));
                o.add("options", options);
            } else if (is(h, "api.value.sync.IBoolSyncValue")) {
                o.addProperty("kind", "switch");
                o.addProperty("value", (Boolean) call(h, "getBoolValue"));
            } else if (is(h, "api.value.sync.IStringSyncValue")) {
                o.addProperty("kind", "text");
                o.addProperty("value", clip(String.valueOf(call(h, "getStringValue"))));
            } else if (is(h, "api.value.sync.IIntSyncValue") || is(h, "api.value.sync.ILongSyncValue")
                || is(h, "api.value.sync.IDoubleSyncValue")
                || is(h, "api.value.sync.IFloatSyncValue")
                || is(h, "api.value.sync.IShortSyncValue")
                || is(h, "api.value.sync.IByteSyncValue")) {
                    o.addProperty("kind", "number");
                    Object v = call(h, "getValue");
                    if (v instanceof Number) o.addProperty("value", (Number) v);
                    else o.addProperty("value", String.valueOf(v));
                } else if (is(h, "api.value.sync.IValueSyncHandler")) {
                    // Something the screen shows and keeps in step; what it is, is the screen's business.
                    o.addProperty("kind", "value");
                    o.addProperty("value", clip(String.valueOf(call(h, "getValue"))));
                    o.addProperty("type", h.getClass().getSimpleName());
                    return o;
                } else {
                    o.addProperty("kind", "other");
                    o.addProperty("type", h.getClass().getSimpleName());
                    return o;
                }
            // Whether the screen takes a change of this from the player at all.
            try {
                if (!(Boolean) call(h, "isAllowC2S")) o.addProperty("readOnly", true);
            } catch (Throwable ignored) {}
        } catch (Throwable t) {
            o.addProperty("kind", "other");
            o.addProperty("type", h.getClass().getSimpleName());
            o.addProperty("unreadable", true);
        }
        return o;
    }

    private static String clip(String s) {
        return s.length() > 200 ? s.substring(0, 200) + "… (" + s.length() + " characters)" : s;
    }

    private static Object find(Container c, String panel, String key) {
        Map<String, Object> panels = panels(c);
        if (panels == null) throw RpcException.badRequest("this screen has no controls of that kind (only its slots can be clicked)");
        Object found = null;
        int matches = 0;
        for (Map.Entry<String, Object> p : panels.entrySet()) {
            if (panel != null && !panel.equals(p.getKey())) continue;
            try {
                Map<String, Object> hs = handlers(p.getValue());
                for (Map.Entry<String, Object> h : hs.entrySet()) {
                    // The full key, or the name before its ":number" when that is unambiguous.
                    String k = h.getKey();
                    if (k.equals(key) || (k.contains(":") && k.substring(0, k.lastIndexOf(':')).equals(key))) {
                        found = h.getValue();
                        matches++;
                    }
                }
            } catch (Throwable ignored) {}
        }
        if (matches == 0) throw RpcException.badRequest("the screen has no control \"" + key + "\"" + (panel != null ? " in panel \"" + panel + "\"" : "") + "; screen.look lists them");
        if (matches > 1) throw RpcException.badRequest("more than one control is called \"" + key + "\": give its full key and its panel");
        return found;
    }

    private static PacketBuffer buffer() {
        return new PacketBuffer(Unpooled.buffer());
    }

    private static PacketBuffer mouse(int button, boolean shift) throws Exception {
        Class<?> data = Class.forName(PKG + "utils.MouseData");
        Object m = data.getConstructor(cpw.mods.fml.relauncher.Side.class, int.class, boolean.class, boolean.class, boolean.class)
            .newInstance(cpw.mods.fml.relauncher.Side.SERVER, button, shift, false, false);
        PacketBuffer buf = buffer();
        data.getMethod("writeToPacket", PacketBuffer.class)
            .invoke(m, buf);
        return buf;
    }

    private static void send(Object handler, int id, PacketBuffer buf) throws Exception {
        Method m = handler.getClass()
            .getMethod("readOnServer", int.class, PacketBuffer.class);
        m.setAccessible(true);
        m.invoke(handler, id, buf);
    }

    /**
     * Presses a control as a click does: a switch flips, a panel opens (or closes when it is open), a button does
     * what it does, a fluid slot takes from or gives to the container on the cursor.
     */
    public static void press(Container c, String panel, String key, int button, boolean shift) {
        Object h = find(c, panel, key);
        try {
            if (is(h, "value.sync.PanelSyncHandler")) {
                boolean open = (Boolean) call(h, "isPanelOpen");
                send(h, open ? 2 : 0, buffer());
            } else if (is(h, "value.sync.FluidSlotSyncHandler")) {
                send(h, 1, mouse(button, shift));
            } else if (is(h, "value.sync.InteractionSyncHandler")) {
                boolean did = false;
                for (String action : new String[] { "mousePressed", "mouseReleased", "mouseTapped" }) {
                    Object a = field(h, action);
                    if (a == null) continue;
                    Class<?> data = Class.forName(PKG + "utils.MouseData");
                    Object m = data.getConstructor(cpw.mods.fml.relauncher.Side.class, int.class, boolean.class, boolean.class, boolean.class)
                        .newInstance(cpw.mods.fml.relauncher.Side.SERVER, button, shift, false, false);
                    for (Method method : a.getClass()
                        .getMethods()) {
                        if (method.getParameterTypes().length == 1 && method.getParameterTypes()[0].isAssignableFrom(data)
                            && method.getDeclaringClass() != Object.class) {
                            method.setAccessible(true);
                            method.invoke(a, m);
                            did = true;
                            break;
                        }
                    }
                }
                if (!did) throw RpcException.badRequest("that button does nothing on the server when clicked");
            } else if (is(h, "api.value.sync.IBoolSyncValue")) {
                requireWritable(h, key);
                boolean now = (Boolean) call(h, "getBoolValue");
                h.getClass()
                    .getMethod("setBoolValue", boolean.class, boolean.class, boolean.class)
                    .invoke(h, !now, true, true);
            } else {
                throw RpcException.badRequest("\"" + key + "\" is not something a click works; set its value instead");
            }
        } catch (RpcException e) {
            throw e;
        } catch (Throwable t) {
            Throwable cause = t.getCause() != null ? t.getCause() : t;
            throw new RpcException("invalid", "the screen did not take that: " + cause);
        }
    }

    private static void requireWritable(Object h, String key) throws Exception {
        try {
            if (!(Boolean) call(h, "isAllowC2S")) {
                throw RpcException.denied("the screen only shows \"" + key + "\"; it does not take a change of it from a player");
            }
        } catch (NoSuchMethodException ignored) {}
    }

    /** Sets a switch, number, text or choice to a value, as typing or picking it does. */
    public static void set(Container c, String panel, String key, JsonElement value) {
        Object h = find(c, panel, key);
        if (value == null || !value.isJsonPrimitive()) throw RpcException.badRequest("value must be true/false, a number or a text");
        try {
            com.google.gson.JsonPrimitive v = value.getAsJsonPrimitive();
            if (isCircuit(h)) {
                // What picking a circuit in its little window sends: the number, or -1 for none.
                int n = v.isNumber() ? v.getAsInt() : "none".equalsIgnoreCase(v.getAsString()) ? 0 : Integer.parseInt(v.getAsString().trim());
                if (n < 0 || n > 24) throw RpcException.badRequest("a programmed circuit is 0 (none) or 1-24");
                PacketBuffer buf = buffer();
                buf.writeShort(n == 0 ? -1 : n);
                send(h, 10, buf);
                return;
            }
            requireWritable(h, key);
            if (is(h, "value.sync.EnumSyncValue")) {
                Object[] all = ((Class<?>) call(h, "getEnumClass")).getEnumConstants();
                Object pick = null;
                for (Object e : all) if (String.valueOf(e).equalsIgnoreCase(v.getAsString()) || ((Enum<?>) e).name().equalsIgnoreCase(v.getAsString())) pick = e;
                if (pick == null && v.isNumber() && v.getAsInt() >= 0 && v.getAsInt() < all.length) pick = all[v.getAsInt()];
                if (pick == null) throw RpcException.badRequest("\"" + key + "\" is one of: " + java.util.Arrays.toString(all));
                h.getClass()
                    .getMethod("setValue", Object.class, boolean.class, boolean.class)
                    .invoke(h, pick, true, true);
            } else if (is(h, "api.value.sync.IBoolSyncValue")) {
                boolean b = v.isBoolean() ? v.getAsBoolean() : v.isNumber() ? v.getAsInt() != 0 : Boolean.parseBoolean(v.getAsString());
                h.getClass()
                    .getMethod("setBoolValue", boolean.class, boolean.class, boolean.class)
                    .invoke(h, b, true, true);
            } else if (is(h, "api.value.sync.IStringSyncValue")) {
                h.getClass()
                    .getMethod("setStringValue", String.class, boolean.class, boolean.class)
                    .invoke(h, v.getAsString(), true, true);
            } else if (is(h, "api.value.sync.IIntSyncValue")) {
                h.getClass()
                    .getMethod("setIntValue", int.class, boolean.class, boolean.class)
                    .invoke(h, v.getAsInt(), true, true);
            } else if (is(h, "api.value.sync.ILongSyncValue")) {
                h.getClass()
                    .getMethod("setLongValue", long.class, boolean.class, boolean.class)
                    .invoke(h, v.getAsLong(), true, true);
            } else if (is(h, "api.value.sync.IDoubleSyncValue")) {
                h.getClass()
                    .getMethod("setDoubleValue", double.class, boolean.class, boolean.class)
                    .invoke(h, v.getAsDouble(), true, true);
            } else if (is(h, "api.value.sync.IFloatSyncValue")) {
                h.getClass()
                    .getMethod("setFloatValue", float.class, boolean.class, boolean.class)
                    .invoke(h, v.getAsFloat(), true, true);
            } else {
                throw RpcException.badRequest("\"" + key + "\" is not a value that can be set; press it, or look at what kind it is");
            }
        } catch (RpcException e) {
            throw e;
        } catch (Throwable t) {
            Throwable cause = t.getCause() != null ? t.getCause() : t;
            throw new RpcException("invalid", "the screen did not take that: " + cause);
        }
    }
}
