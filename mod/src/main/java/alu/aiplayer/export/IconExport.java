package alu.aiplayer.export;

import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.io.File;
import java.lang.reflect.Field;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.IntBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.FontRenderer;
import net.minecraft.client.renderer.OpenGlHelper;
import net.minecraft.client.renderer.RenderHelper;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.entity.RenderItem;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.renderer.texture.ITextureObject;
import net.minecraft.client.renderer.texture.TextureManager;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.item.ItemStack;
import net.minecraft.util.ReportedException;
import net.minecraft.util.ResourceLocation;

import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL12;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import alu.aiplayer.AiPlayerMod;

/**
 * Draws every item of items.jsonl the way a slot of the inventory shows it and writes the pictures as sheets:
 * icon n is line n of items.jsonl, so nothing else is needed to find one (docs/PACKDATA.md, "icons").
 * <p>
 * The game draws items for a screen that is opaque, and what its drawing leaves in the alpha channel means
 * nothing (flat items wipe it, glass squares it). So every item is drawn twice, on black and on white, and the
 * two pictures say exactly how much of the background showed through: that is the transparency, and the colour
 * follows from it. The drawing itself is the call the inventory makes, on the client thread, a batch at a time.
 * <p>
 * The stack drawn for a line is the one {@link ItemRows} gives for it. Client only.
 */
final class IconExport {

    static final int CELL = 32;
    static final int COLUMNS = 64;
    static final int ROWS = 64;
    private static final int PER_SHEET = COLUMNS * ROWS;
    /** How many rows of icons one visit to the client thread draws; has to divide ROWS. */
    private static final int BATCH_ROWS = 16;
    private static final int BATCH = BATCH_ROWS * COLUMNS;
    private static final int W = COLUMNS * CELL;
    private static final int HALF = BATCH_ROWS * CELL;
    private static final int H = 2 * HALF;
    private static final long BUDGET_MS = 10 * 60 * 1000L;
    private static final int ERRORS_KEPT = 200;
    private static final ResourceLocation GLINT = new ResourceLocation("textures/misc/enchanted_item_glint.png");

    private final File dir;
    private final Minecraft mc = Minecraft.getMinecraft();
    private final RenderItem render = new RenderItem();
    private Framebuffer target;
    private IntBuffer readBack;
    private ITextureObject glintBefore;
    private DynamicTexture noGlint;
    private int modelviewDepth, projectionDepth, attribDepth;
    private long drawNanos;

    private IconExport(File dir) {
        this.dir = dir;
    }

    /** Draws the icons of {@code dir/items.jsonl} into {@code dir/icons/}; returns what icons.json says. */
    static JsonObject run(File dir) throws Exception {
        return new IconExport(dir).all();
    }

    private JsonObject all() throws Exception {
        long t0 = System.currentTimeMillis();
        File out = new File(dir, "icons");
        if (!out.isDirectory() && !out.mkdirs()) throw new IllegalStateException("cannot create " + out);
        // Whoever reads the directory goes by this file; without it a run that stopped halfway is no icons at all.
        Files.deleteIfExists(new File(out, "icons.json").toPath());

        ItemRows rows = new ItemRows(dir);
        int total = rows.size();
        AiPlayerMod.LOG.info("export: drawing {} icons ({} of them as NEI lists them)", total, rows.countListed());

        int sheets = (total + PER_SHEET - 1) / PER_SHEET;
        List<Integer> missing = new ArrayList<>();
        JsonArray errors = new JsonArray();
        int failed = 0;
        int cutShort = -1;
        long deadline = t0 + BUDGET_MS;
        long lastLog = t0;
        JsonArray files = new JsonArray();
        try {
            for (int sheet = 0; sheet < sheets; sheet++) {
                BufferedImage image = new BufferedImage(W, ROWS * CELL, BufferedImage.TYPE_INT_ARGB);
                int[] pixels = ((DataBufferInt) image.getRaster()
                    .getDataBuffer()).getData();
                int sheetStart = sheet * PER_SHEET, sheetEnd = Math.min(total, sheetStart + PER_SHEET);
                for (int first = sheetStart; first < sheetEnd; first += BATCH) {
                    if (cutShort >= 0 || System.currentTimeMillis() > deadline) {
                        if (cutShort < 0) {
                            cutShort = first;
                            AiPlayerMod.LOG.warn("export: icons cut short at {} of {}, out of time", first, total);
                        }
                        for (int i = first; i < Math.min(sheetEnd, first + BATCH); i++) missing.add(i);
                        continue;
                    }
                    final int count = Math.min(BATCH, sheetEnd - first);
                    final ItemStack[] stacks = new ItemStack[count];
                    for (int k = 0; k < count; k++) stacks[k] = rows.stack(first + k);
                    final String[] problems = new String[count];
                    Callable<int[]> job = () -> batch(stacks, problems);
                    @SuppressWarnings("unchecked")
                    int[] drawn = (int[]) mc.func_152343_a(job)
                        .get(180, TimeUnit.SECONDS);
                    for (int k = 0; k < count; k++) {
                        int i = first + k;
                        if (problems[k] == null && stacks[k] == null) problems[k] = "no such item";
                        boolean something = problems[k] == null && matte(drawn, k, pixels, i - sheetStart);
                        if (something) continue;
                        missing.add(i);
                        if (problems[k] == null) continue;
                        failed++;
                        if (errors.size() < ERRORS_KEPT) {
                            JsonArray e = new JsonArray();
                            e.add(new JsonPrimitive(i));
                            e.add(new JsonPrimitive(problems[k]));
                            errors.add(e);
                        }
                    }
                    long now = System.currentTimeMillis();
                    if (now - lastLog >= 5000) {
                        lastLog = now;
                        AiPlayerMod.LOG.info(
                            "export: icons {} of {}, {} empty or failed, {} s",
                            first + count,
                            total,
                            missing.size(),
                            (now - t0) / 1000);
                    }
                }
                String name = String.format("icons-%03d.png", sheet);
                File part = new File(out, name + ".part");
                if (!javax.imageio.ImageIO.write(image, "png", part)) throw new IllegalStateException("no PNG writer here");
                Files.move(part.toPath(), new File(out, name).toPath(), StandardCopyOption.REPLACE_EXISTING);
                files.add(new JsonPrimitive(name));
            }
        } finally {
            try {
                Callable<Object> done = () -> {
                    release();
                    return null;
                };
                mc.func_152343_a(done)
                    .get(60, TimeUnit.SECONDS);
            } catch (Throwable ignored) {}
        }
        // Sheets of an earlier, longer list.
        File[] old = out.listFiles();
        if (old != null) for (File f : old) {
            String n = f.getName();
            if (n.startsWith("icons-") && (n.endsWith(".png") || n.endsWith(".part")) && !contains(files, n)) f.delete();
        }

        JsonObject o = new JsonObject();
        o.addProperty("format", 1);
        o.addProperty("generatedAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX").format(new java.util.Date()));
        o.addProperty("cell", CELL);
        o.addProperty("columns", COLUMNS);
        o.addProperty("rows", ROWS);
        o.addProperty("count", total);
        o.addProperty("itemsSha1", rows.sha1);
        o.add("files", files);
        JsonArray m = new JsonArray();
        for (int i : missing) m.add(new JsonPrimitive(i));
        o.add("missing", m);
        o.addProperty("failed", failed);
        if (errors.size() > 0) o.add("errors", errors);
        if (cutShort >= 0) o.addProperty("cutShort", cutShort);
        long ms = System.currentTimeMillis() - t0;
        o.addProperty("seconds", Math.round(ms / 100.0) / 10.0);
        File part = new File(out, "icons.json.part");
        Files.write(part.toPath(), o.toString().getBytes(StandardCharsets.UTF_8));
        Files.move(part.toPath(), new File(out, "icons.json").toPath(), StandardCopyOption.REPLACE_EXISTING);
        AiPlayerMod.LOG.info(
            "export: {} icons on {} sheets in {} s ({} s of it drawing), {} empty, {} failed",
            total,
            sheets,
            ms / 1000,
            drawNanos / 1000000000L,
            missing.size() - failed,
            failed);
        return o;
    }

    private static boolean contains(JsonArray a, String s) {
        for (int i = 0; i < a.size(); i++) if (a.get(i)
            .getAsString()
            .equals(s)) return true;
        return false;
    }

    // ---- on the client thread -------------------------------------------------------------------------------

    /**
     * Draws up to one batch into the off-screen target, each item once in the lower half on black and once in
     * the upper half on white, and returns the target's pixels (rows from the bottom up, as OpenGL gives them).
     */
    private int[] batch(ItemStack[] stacks, String[] problems) {
        long t0 = System.nanoTime();
        if (target == null) prepare();
        GL11.glPushAttrib(GL11.GL_ALL_ATTRIB_BITS);
        GL11.glMatrixMode(GL11.GL_PROJECTION);
        GL11.glPushMatrix();
        GL11.glMatrixMode(GL11.GL_MODELVIEW);
        GL11.glPushMatrix();
        int[] out = new int[W * H];
        try {
            modelviewDepth = GL11.glGetInteger(GL11.GL_MODELVIEW_STACK_DEPTH);
            projectionDepth = GL11.glGetInteger(GL11.GL_PROJECTION_STACK_DEPTH);
            attribDepth = GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH);
            target.bindFramebuffer(false);
            GL11.glColorMask(true, true, true, true);
            GL11.glDepthMask(true);
            GL11.glClearDepth(1.0);
            GL11.glEnable(GL11.GL_SCISSOR_TEST);
            wipe(0, 0, W, HALF, 0f);
            wipe(0, HALF, W, HALF, 1f);
            for (int k = 0; k < stacks.length; k++) {
                if (stacks[k] == null) continue;
                int x = (k % COLUMNS) * CELL, y = (BATCH_ROWS - 1 - k / COLUMNS) * CELL;
                String problem = draw(stacks[k], x, y);
                if (problem == null) problem = draw(stacks[k], x, y + HALF);
                if (problem == null) continue;
                problems[k] = problem;
                // Whatever got drawn before it broke is not the item.
                target.bindFramebuffer(false);
                GL11.glColorMask(true, true, true, true);
                GL11.glDepthMask(true);
                GL11.glEnable(GL11.GL_SCISSOR_TEST);
                wipe(x, y, CELL, CELL, 0f);
                wipe(x, y + HALF, CELL, CELL, 1f);
            }
            target.bindFramebuffer(false);
            GL11.glPixelStorei(GL11.GL_PACK_ALIGNMENT, 1);
            readBack.clear();
            GL11.glReadPixels(0, 0, W, H, GL12.GL_BGRA, GL12.GL_UNSIGNED_INT_8_8_8_8_REV, readBack);
            readBack.get(out);
        } finally {
            tidy();
            GL11.glMatrixMode(GL11.GL_PROJECTION);
            GL11.glPopMatrix();
            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            GL11.glPopMatrix();
            GL11.glPopAttrib();
            target.unbindFramebuffer();
            drawNanos += System.nanoTime() - t0;
        }
        return out;
    }

    private void prepare() {
        // Without one the drawing would land on the window, which is neither this size nor ours to scribble on.
        if (!OpenGlHelper.isFramebufferEnabled()) throw new IllegalStateException("this game runs without framebuffer objects");
        target = new Framebuffer(W, H, true);
        readBack = ByteBuffer.allocateDirect(W * H * 4)
            .order(ByteOrder.nativeOrder())
            .asIntBuffer();
        // No shimmer on enchanted things: it is drawn by adding this texture, and adding black adds nothing.
        TextureManager textures = mc.getTextureManager();
        glintBefore = textures.getTexture(GLINT);
        noGlint = new DynamicTexture(16, 16);
        java.util.Arrays.fill(noGlint.getTextureData(), 0xFF000000);
        noGlint.updateDynamicTexture();
        textures.loadTexture(GLINT, noGlint);
    }

    private void release() {
        if (target == null) return;
        target.deleteFramebuffer();
        target = null;
        TextureManager textures = mc.getTextureManager();
        if (glintBefore != null) textures.loadTexture(GLINT, glintBefore);
        else textures.deleteTexture(GLINT);
        if (glintBefore != null) noGlint.deleteGlTexture();
    }

    private static void wipe(int x, int y, int w, int h, float shade) {
        GL11.glScissor(x, y, w, h);
        GL11.glClearColor(shade, shade, shade, 1f);
        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
    }

    /** One item into one cell, set up as a slot of an inventory screen is. Returns what went wrong, if anything. */
    private String draw(ItemStack stack, int x, int y) {
        target.bindFramebuffer(false);
        GL11.glViewport(x, y, CELL, CELL);
        GL11.glEnable(GL11.GL_SCISSOR_TEST);
        GL11.glScissor(x, y, CELL, CELL);
        // The same numbers as the game's own screens, with the 16 units of a slot filling the cell.
        GL11.glMatrixMode(GL11.GL_PROJECTION);
        GL11.glLoadIdentity();
        GL11.glOrtho(0.0, 16.0, 16.0, 0.0, 1000.0, 3000.0);
        GL11.glMatrixMode(GL11.GL_MODELVIEW);
        GL11.glLoadIdentity();
        GL11.glTranslatef(0f, 0f, -2000f);
        GL11.glColorMask(true, true, true, true);
        GL11.glDepthMask(true);
        GL11.glEnable(GL11.GL_DEPTH_TEST);
        GL11.glDepthFunc(GL11.GL_LEQUAL);
        GL11.glEnable(GL11.GL_ALPHA_TEST);
        GL11.glAlphaFunc(GL11.GL_GREATER, 0.1f);
        GL11.glDisable(GL11.GL_BLEND);
        OpenGlHelper.glBlendFunc(770, 771, 1, 0);
        GL11.glEnable(GL11.GL_TEXTURE_2D);
        GL11.glEnable(GL11.GL_CULL_FACE);
        GL11.glDisable(GL11.GL_FOG);
        GL11.glShadeModel(GL11.GL_FLAT);
        GL11.glEnable(GL12.GL_RESCALE_NORMAL);
        RenderHelper.enableGUIStandardItemLighting();
        OpenGlHelper.setLightmapTextureCoords(OpenGlHelper.lightmapTexUnit, 240f, 240f);
        GL11.glColor4f(1f, 1f, 1f, 1f);
        String problem = null;
        FontRenderer font = mc.fontRenderer;
        try {
            render.zLevel = 100f;
            render.renderItemAndEffectIntoGUI(font, mc.getTextureManager(), stack, 0, 0);
        } catch (Throwable t) {
            problem = describe(t);
        }
        render.zLevel = 0f;
        if (tidy() && problem == null) problem = "left the tessellator drawing";
        return problem;
    }

    private static String describe(Throwable t) {
        if (t instanceof ReportedException) {
            try {
                Throwable cause = ((ReportedException) t).getCrashReport()
                    .getCrashCause();
                if (cause != null) t = cause;
            } catch (Throwable ignored) {}
        }
        String s = String.valueOf(t);
        StackTraceElement[] at = t.getStackTrace();
        if (at != null && at.length > 0) s += " at " + at[0];
        return s.length() > 300 ? s.substring(0, 300) : s;
    }

    private static Field drawing;
    private static boolean drawingLooked;

    private static boolean stillDrawing() {
        if (!drawingLooked) {
            drawingLooked = true;
            for (String name : new String[] { "field_78415_z", "isDrawing" }) {
                try {
                    Field f = Tessellator.class.getDeclaredField(name);
                    f.setAccessible(true);
                    drawing = f;
                    break;
                } catch (Throwable ignored) {}
            }
        }
        try {
            return drawing != null && drawing.getBoolean(Tessellator.instance);
        } catch (Throwable t) {
            return false;
        }
    }

    /** Puts back what a drawing that broke off may have left open. Returns whether the tessellator was open. */
    private boolean tidy() {
        boolean open = false;
        try {
            if (stillDrawing()) {
                open = true;
                Tessellator.instance.draw();
            }
        } catch (Throwable ignored) {}
        try {
            GL11.glMatrixMode(GL11.GL_PROJECTION);
            for (int i = GL11.glGetInteger(GL11.GL_PROJECTION_STACK_DEPTH); i > projectionDepth; i--) GL11.glPopMatrix();
            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            for (int i = GL11.glGetInteger(GL11.GL_MODELVIEW_STACK_DEPTH); i > modelviewDepth; i--) GL11.glPopMatrix();
            for (int i = GL11.glGetInteger(GL11.GL_ATTRIB_STACK_DEPTH); i > attribDepth; i--) GL11.glPopAttrib();
            OpenGlHelper.setActiveTexture(OpenGlHelper.defaultTexUnit);
        } catch (Throwable ignored) {}
        return open;
    }

    // ---- back on the export thread --------------------------------------------------------------------------

    /**
     * Works out one icon from its two drawings and puts it into the sheet. Where the two agree the item covered
     * the pixel; where white stayed white and black stayed black nothing was there. Returns whether anything was.
     */
    private static boolean matte(int[] drawn, int k, int[] sheet, int cell) {
        int x0 = (k % COLUMNS) * CELL, yBottom = (BATCH_ROWS - 1 - k / COLUMNS) * CELL;
        int sx = (cell % COLUMNS) * CELL, sy = (cell / COLUMNS) * CELL;
        boolean something = false;
        for (int y = 0; y < CELL; y++) {
            int black = (yBottom + CELL - 1 - y) * W + x0;
            int white = black + HALF * W;
            int to = (sy + y) * W + sx;
            for (int x = 0; x < CELL; x++) {
                int b = drawn[black + x], w = drawn[white + x];
                int br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
                int through = ((w >> 16) & 255) - br + ((w >> 8) & 255) - bg + (w & 255) - bb;
                int a = 255 - (through + 1) / 3;
                if (a <= 0) continue;
                something = true;
                if (a >= 255) {
                    sheet[to + x] = 0xFF000000 | (b & 0xFFFFFF);
                    continue;
                }
                int r = Math.min(255, (br * 255 + a / 2) / a);
                int g = Math.min(255, (bg * 255 + a / 2) / a);
                int bl = Math.min(255, (bb * 255 + a / 2) / a);
                sheet[to + x] = (a << 24) | (r << 16) | (g << 8) | bl;
            }
        }
        return something;
    }
}
