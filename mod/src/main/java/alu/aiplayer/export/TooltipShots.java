package alu.aiplayer.export;

import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.IntBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;

import net.minecraft.client.Minecraft;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.item.ItemStack;

import org.lwjgl.input.Keyboard;
import org.lwjgl.opengl.Display;
import org.lwjgl.opengl.DisplayMode;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL12;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import alu.aiplayer.AiPlayerMod;

/**
 * Pictures of the game showing tooltips, to hold the text {@link TooltipExport} wrote against what a player sees
 * (tools/tooltip-check). Not part of an export.
 * <p>
 * For each line of {@code shots/list.txt} ("row key": a line number of items.jsonl and none, shift or ctrl) the
 * inventory screen is left to draw itself with that stack under the mouse and that key held, the way
 * {@link Hover} arranges it, and the finished frame is saved. After that, for the lines with shift, once more with
 * nothing arranged about the keys: whoever started this is told through a file to press the real Shift key, so
 * that both ways of holding it can be compared. Client only.
 */
final class TooltipShots {

    private final File dir;
    private final Minecraft mc = Minecraft.getMinecraft();
    private final Hover hover = new Hover();
    /** For each picture: where in it the tooltip is (x, y, width, height in pixels) and how many pages it has. */
    private final JsonObject places = new JsonObject();

    private TooltipShots(File dir) {
        this.dir = dir;
    }

    static void run(File dir) throws Exception {
        new TooltipShots(new File(dir, "shots")).all(new ItemRows(dir));
    }

    private <T> T onClient(Callable<T> job) throws Exception {
        @SuppressWarnings("unchecked")
        T done = (T) mc.func_152343_a(job)
            .get(60, TimeUnit.SECONDS);
        return done;
    }

    private void all(ItemRows rows) throws Exception {
        List<int[]> wanted = new ArrayList<>();
        List<String> keys = new ArrayList<>();
        for (String line : Files.readAllLines(new File(dir, "list.txt").toPath(), StandardCharsets.UTF_8)) {
            String[] parts = line.trim()
                .split("\\s+");
            if (parts.length < 2) continue;
            wanted.add(new int[] { Integer.parseInt(parts[0]) });
            keys.add(parts[1]);
        }
        for (String mark : new String[] { "want-shift", "shift-down", "done" }) new File(dir, mark).delete();
        // Room for long tooltips: twice the usual window, at the usual size of the letters.
        onClient(() -> {
            mc.gameSettings.guiScale = 2;
            Display.setDisplayMode(new DisplayMode(1708, 960));
            return null;
        });
        Thread.sleep(2000);
        onClient(() -> {
            hover.open();
            return null;
        });
        Thread.sleep(2000);
        JsonObject result = new JsonObject();
        result.addProperty("width", mc.displayWidth);
        result.addProperty("height", mc.displayHeight);
        try {
            shot(null, "none", false, new File(dir, "base.png"));
            for (int i = 0; i < wanted.size(); i++) {
                int row = wanted.get(i)[0];
                shot(rows.stack(row), keys.get(i), false, new File(dir, row + "-" + keys.get(i) + ".png"));
            }
            // The same again with the keyboard left alone and the real key pressed from outside.
            Files.write(new File(dir, "want-shift").toPath(), new byte[0]);
            File down = new File(dir, "shift-down");
            for (int i = 0; i < 300 && !down.exists(); i++) Thread.sleep(100);
            boolean seen = down.exists() && onClient(() -> {
                hover.keysBack();
                return Keyboard.isKeyDown(Keyboard.KEY_LSHIFT);
            });
            result.addProperty("realShiftSeen", seen);
            if (seen) {
                for (int i = 0; i < wanted.size(); i++) {
                    if (!"shift".equals(keys.get(i))) continue;
                    int row = wanted.get(i)[0];
                    shot(rows.stack(row), "shift", true, new File(dir, row + "-shift-real.png"));
                }
            }
        } finally {
            try {
                onClient(() -> {
                    hover.close();
                    return null;
                });
            } catch (Throwable ignored) {}
            result.add("tooltips", places);
            Files.write(new File(dir, "result.json").toPath(), result.toString().getBytes(StandardCharsets.UTF_8));
            Files.write(new File(dir, "done").toPath(), new byte[0]);
        }
        AiPlayerMod.LOG.info("export: {} pictures of tooltips in {}", wanted.size(), dir);
    }

    private void shot(ItemStack stack, String key, boolean realKeys, File to) throws Exception {
        onClient(() -> {
            hover.aim();
            hover.over(stack);
            if (realKeys) hover.keysBack();
            else if ("shift".equals(key)) hover.keys(Keyboard.KEY_LSHIFT);
            else if ("ctrl".equals(key)) hover.keys(Keyboard.KEY_LCONTROL);
            else hover.keys();
            return null;
        });
        // A few frames: the tooltip slides in, and the mouse is put back where it belongs before each of them.
        for (int i = 0; i < 8; i++) {
            Thread.sleep(100);
            onClient(() -> {
                hover.aim();
                return null;
            });
        }
        BufferedImage image = onClient(this::frame);
        javax.imageio.ImageIO.write(image, "png", to);
        JsonArray where = onClient(this::where);
        if (where != null) places.add(to.getName(), where);
        onClient(() -> {
            hover.over(null);
            return null;
        });
    }

    /** Asks ChromaticTooltips where it put the tooltip it drew last; null when it is not there or drew none. */
    private JsonArray where() {
        try {
            Class<?> handler = Class.forName("com.slprime.chromatictooltips.TooltipHandler");
            Object context = handler.getMethod("getLastTooltipContext")
                .invoke(null);
            if (context == null) return null;
            java.lang.reflect.Field last = handler.getDeclaredField("lastMousePosition");
            last.setAccessible(true);
            java.awt.Point mouse = (java.awt.Point) last.get(null);
            java.awt.Dimension size = (java.awt.Dimension) context.getClass()
                .getMethod("getTooltipSize")
                .invoke(context);
            java.lang.reflect.Method place = context.getClass()
                .getDeclaredMethod("prepareTooltipPosition", int.class, int.class);
            place.setAccessible(true);
            java.awt.Point at = (java.awt.Point) place.invoke(context, mouse.x, mouse.y);
            java.lang.reflect.Field pages = context.getClass()
                .getDeclaredField("pagedComponents");
            pages.setAccessible(true);
            Object paged = pages.get(context);
            int scale = new net.minecraft.client.gui.ScaledResolution(mc, mc.displayWidth, mc.displayHeight).getScaleFactor();
            JsonArray a = new JsonArray();
            a.add(new JsonPrimitive(at.x * scale));
            a.add(new JsonPrimitive(at.y * scale));
            a.add(new JsonPrimitive(size.width * scale));
            a.add(new JsonPrimitive(size.height * scale));
            a.add(new JsonPrimitive(paged instanceof List ? ((List<?>) paged).size() : 1));
            return a;
        } catch (Throwable t) {
            return null;
        }
    }

    /** What the game drew last, read back from where it draws before that goes to the window. */
    private BufferedImage frame() {
        Framebuffer fb = mc.getFramebuffer();
        int w = fb.framebufferWidth, h = fb.framebufferHeight;
        IntBuffer buffer = ByteBuffer.allocateDirect(w * h * 4)
            .order(ByteOrder.nativeOrder())
            .asIntBuffer();
        fb.bindFramebuffer(false);
        GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 1);
        GL11.glReadPixels(0, 0, w, h, GL12.GL_BGRA, GL12.GL_UNSIGNED_INT_8_8_8_8_REV, buffer);
        fb.unbindFramebuffer();
        int[] pixels = new int[w * h];
        buffer.get(pixels);
        BufferedImage image = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) image.setRGB(0, y, w, 1, pixels, (h - 1 - y) * w, w);
        return image;
    }
}
