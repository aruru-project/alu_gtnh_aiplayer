package alu.aiplayer.export;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.ScaledResolution;
import net.minecraft.client.gui.inventory.GuiContainer;
import net.minecraft.client.gui.inventory.GuiInventory;
import net.minecraft.inventory.Slot;
import net.minecraft.item.ItemStack;

import org.lwjgl.input.Keyboard;

import alu.aiplayer.AiPlayerMod;
import codechicken.nei.guihook.GuiContainerManager;
import codechicken.nei.guihook.IContainerObjectHandler;

/**
 * Puts the game where a player is who reads a tooltip: the inventory screen open, the mouse resting on a slot,
 * a chosen stack in that slot, chosen keys held. Nothing is sent to the server and no real input is made: the
 * stack under the mouse is answered through NEI (the way its own item panel does it), and the mouse position and
 * the keys held are swapped where the game reads them, for as long as one piece of work on the client thread
 * lasts. Everything that builds a tooltip then runs as it does for a player, whichever mod it belongs to.
 * <p>
 * All of it on the client thread. Client only.
 */
final class Hover implements IContainerObjectHandler {

    private final Minecraft mc = Minecraft.getMinecraft();
    private GuiContainer screen;
    private boolean opened;
    private boolean registered;
    private ItemStack stack;

    // Where the game reads the keys held. With lwjgl3ify that is a state array handed over by SDL, behind a public
    // field; with the original LWJGL a buffer of its own.
    private Field sdlKeys;
    private Method sdlScancode;
    private Object keysBefore;
    private boolean keysSwapped;
    private ByteBuffer lwjglKeys;
    private byte[] lwjglBefore;
    private final Field[] mouse = new Field[4];
    private final int[] mouseBefore = new int[4];
    private boolean mouseMoved;

    Hover() {
        try {
            Class<?> keyboard = Class.forName("org.lwjglx.input.Keyboard");
            sdlKeys = keyboard.getField("sdlKeyPressedArray");
            sdlScancode = Class.forName("org.lwjglx.input.KeyCodes")
                .getMethod("lwjglToSdlScancode", int.class);
        } catch (Throwable notLwjgl3ify) {
            sdlKeys = null;
            try {
                Field f = Class.forName("org.lwjgl.input.Keyboard")
                    .getDeclaredField("keyDownBuffer");
                f.setAccessible(true);
                lwjglKeys = (ByteBuffer) f.get(null);
            } catch (Throwable t) {
                AiPlayerMod.LOG.warn("export: no way to hold a key here, tooltips are read without Shift", t);
            }
        }
        String[] names = { "x", "y", "latestX", "latestY" };
        for (String owner : new String[] { "org.lwjglx.input.Mouse", "org.lwjgl.input.Mouse" }) {
            try {
                Class<?> c = Class.forName(owner);
                for (int i = 0; i < names.length; i++) {
                    try {
                        mouse[i] = c.getDeclaredField(names[i]);
                        mouse[i].setAccessible(true);
                    } catch (Throwable ignored) {}
                }
                if (mouse[0] != null) break;
            } catch (Throwable ignored) {}
        }
    }

    /** Opens the inventory screen unless a screen with slots is open already. */
    void open() {
        if (!(mc.currentScreen instanceof GuiContainer) && mc.thePlayer != null) {
            mc.displayGuiScreen(new GuiInventory(mc.thePlayer));
            opened = true;
        }
        screen = mc.currentScreen instanceof GuiContainer ? (GuiContainer) mc.currentScreen : null;
        if (!registered) {
            GuiContainerManager.addObjectHandler(this);
            registered = true;
        }
    }

    void close() {
        stack = null;
        keysBack();
        mouseBack();
        if (registered) {
            GuiContainerManager.objectHandlers.remove(this);
            registered = false;
        }
        if (opened && mc.currentScreen == screen) mc.displayGuiScreen(null);
        opened = false;
        screen = null;
    }

    GuiContainer screen() {
        return screen;
    }

    /** The stack the mouse is over from now on; null for none. */
    void over(ItemStack s) {
        stack = s;
    }

    /** Rests the mouse on the first slot of the hotbar; the game computes its own coordinates from this. */
    void aim() {
        if (screen == null || mouse[0] == null || mouse[1] == null) return;
        try {
            Slot slot = null;
            for (Object o : screen.inventorySlots.inventorySlots) {
                Slot s = (Slot) o;
                if (s.inventory == mc.thePlayer.inventory && s.getSlotIndex() == 0) {
                    slot = s;
                    break;
                }
            }
            if (slot == null) return;
            int gx = guiField("field_147003_i", "guiLeft") + slot.xDisplayPosition + 8;
            int gy = guiField("field_147009_r", "guiTop") + slot.yDisplayPosition + 8;
            ScaledResolution res = new ScaledResolution(mc, mc.displayWidth, mc.displayHeight);
            int sw = res.getScaledWidth(), sh = res.getScaledHeight();
            int x = (gx * mc.displayWidth + mc.displayWidth / 2) / sw;
            int y = ((sh - 1 - gy) * mc.displayHeight + mc.displayHeight / 2) / sh;
            if (!mouseMoved) {
                for (int i = 0; i < mouse.length; i++) if (mouse[i] != null) mouseBefore[i] = mouse[i].getInt(null);
                mouseMoved = true;
            }
            for (int i = 0; i < mouse.length; i++) if (mouse[i] != null) mouse[i].setInt(null, i % 2 == 0 ? x : y);
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("export: could not rest the mouse on a slot", t);
        }
    }

    private int guiField(String srg, String mcp) throws Exception {
        Field f;
        try {
            f = GuiContainer.class.getDeclaredField(srg);
        } catch (NoSuchFieldException e) {
            f = GuiContainer.class.getDeclaredField(mcp);
        }
        f.setAccessible(true);
        return f.getInt(screen);
    }

    void mouseBack() {
        if (!mouseMoved) return;
        mouseMoved = false;
        try {
            for (int i = 0; i < mouse.length; i++) if (mouse[i] != null) mouse[i].setInt(null, mouseBefore[i]);
        } catch (Throwable ignored) {}
    }

    /** From now on exactly these keys (LWJGL key codes) are held, whatever the real keyboard does. */
    void keys(int... held) {
        try {
            if (sdlKeys != null) {
                if (!keysSwapped) {
                    keysBefore = sdlKeys.get(null);
                    keysSwapped = true;
                }
                int size = keysBefore instanceof ByteBuffer ? Math.max(512, ((ByteBuffer) keysBefore).limit()) : 512;
                ByteBuffer pretend = ByteBuffer.allocate(size);
                for (int key : held) {
                    int at = (Integer) sdlScancode.invoke(null, key);
                    if (at > 0 && at < size) pretend.put(at, (byte) 1);
                }
                sdlKeys.set(null, pretend);
            } else if (lwjglKeys != null) {
                if (lwjglBefore == null) {
                    lwjglBefore = new byte[lwjglKeys.capacity()];
                    for (int i = 0; i < lwjglBefore.length; i++) lwjglBefore[i] = lwjglKeys.get(i);
                }
                for (int i = 0; i < lwjglKeys.capacity(); i++) lwjglKeys.put(i, (byte) 0);
                for (int key : held) if (key > 0 && key < lwjglKeys.capacity()) lwjglKeys.put(key, (byte) 1);
            }
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("export: could not hold a key", t);
        }
    }

    void keysBack() {
        try {
            if (keysSwapped) {
                sdlKeys.set(null, keysBefore);
                keysSwapped = false;
                keysBefore = null;
            }
            if (lwjglBefore != null) {
                for (int i = 0; i < lwjglBefore.length; i++) lwjglKeys.put(i, lwjglBefore[i]);
                lwjglBefore = null;
            }
        } catch (Throwable ignored) {}
    }

    /** Whether holding a key this way is seen by the game: Shift reads as held while it is, and not after. */
    boolean keysWork() {
        keys(Keyboard.KEY_LSHIFT);
        boolean down = Keyboard.isKeyDown(Keyboard.KEY_LSHIFT);
        keys();
        boolean up = !Keyboard.isKeyDown(Keyboard.KEY_LSHIFT);
        keysBack();
        return down && up;
    }

    // ---- what NEI asks about the screen ----------------------------------------------------------------------

    @Override
    public void guiTick(GuiContainer gui) {}

    @Override
    public void refresh(GuiContainer gui) {}

    @Override
    public void load(GuiContainer gui) {}

    @Override
    public ItemStack getStackUnderMouse(GuiContainer gui, int mousex, int mousey) {
        return stack;
    }

    @Override
    public boolean objectUnderMouse(GuiContainer gui, int mousex, int mousey) {
        return false;
    }

    @Override
    public boolean shouldShowTooltip(GuiContainer gui) {
        return true;
    }
}
