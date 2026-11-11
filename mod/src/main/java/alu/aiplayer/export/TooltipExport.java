package alu.aiplayer.export;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.ScaledResolution;
import net.minecraft.client.gui.inventory.GuiContainer;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.item.ItemStack;
import net.minecraftforge.event.ForgeEventFactory;

import org.lwjgl.input.Keyboard;
import org.lwjgl.input.Mouse;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import alu.aiplayer.AiPlayerMod;
import codechicken.nei.guihook.GuiContainerManager;
import codechicken.nei.guihook.IContainerTooltipHandler;

/**
 * Writes down what a player reads when the mouse rests on an item in the inventory: the lines under the name,
 * and the lines there are instead while Shift is held (or Ctrl, for the few items that answer to it), for every
 * line of items.jsonl (docs/PACKDATA.md, "tooltips").
 * <p>
 * A tooltip is not text that lies somewhere: every mod adds to it at the moment it is shown (the item itself, what
 * listens to Forge's tooltip event, NEI's handlers), and in this pack one mod (ChromaticTooltips) then lays it all
 * out in sections of its own, with further ones for burn time, durability, food and the like, and decides which
 * section shows with which key held. So this asks that mod for the finished tooltip, in the state {@link Hover}
 * sets up, and reads the text back out of its parts. Where the mod is not there, the list the game and NEI make
 * is taken as it is. All of it is reached by name, so that the mod builds and runs without those mods.
 * <p>
 * Colours and styles are dropped, the order of the lines is kept. Client only.
 */
final class TooltipExport {

    private static final int BATCH = 256;
    private static final long BUDGET_MS = 20 * 60 * 1000L;
    private static final int ERRORS_KEPT = 200;
    /** How many tooltips are read a second time, slowly, to see that reading them fast gives the same. */
    private static final int CHECKED = 300;

    /** What one item gave. */
    private static final class Tip {

        List<String> plain;
        List<String> shift;
        /** With Ctrl held, when that shows something of the item's own (and not its ore dictionary names). */
        List<String> ctrl;
        String error;
        /** Only when probing: every section, with each key. */
        JsonObject probe;
    }

    private final File dir;
    private final Minecraft mc = Minecraft.getMinecraft();
    private final Hover hover = new Hover();
    private final Layout layout = Layout.find();
    private final boolean probe = Boolean.getBoolean("aiplayer.export.tooltips.probe");
    private final Map<String, Integer> pictures = new TreeMap<>();
    private final Map<String, Integer> holds = new TreeMap<>();
    private final List<String> handlers = new ArrayList<>();
    /** Whether the tooltip read last listed ore dictionary names. */
    private boolean oreNames;
    private boolean counting = true;
    /** The game's tick at which a tooltip was last read slowly. */
    private int tick = -1;
    private long workNanos;

    private TooltipExport(File dir) {
        this.dir = dir;
    }

    /** Reads the tooltips of {@code dir/items.jsonl} into {@code dir/tooltips.jsonl}; returns the summary. */
    static JsonObject run(File dir) throws Exception {
        return new TooltipExport(dir).all();
    }

    private <T> T onClient(Callable<T> job, int seconds) throws Exception {
        @SuppressWarnings("unchecked")
        T done = (T) mc.func_152343_a(job)
            .get(seconds, TimeUnit.SECONDS);
        return done;
    }

    private JsonObject all() throws Exception {
        long t0 = System.currentTimeMillis();
        File summary = new File(dir, "tooltips.json");
        // Whoever takes tooltips.jsonl goes by this file; without it a run that stopped halfway left nothing.
        Files.deleteIfExists(summary.toPath());
        ItemRows rows = new ItemRows(dir);
        int total = rows.size();
        boolean keys = onClient(() -> {
            hover.open();
            return hover.keysWork();
        }, 60);
        // The screen that was just opened gets a frame or two to settle (NEI builds its handlers for it then).
        Thread.sleep(1500);
        onClient(() -> {
            GuiContainerManager manager = GuiContainerManager.getManager();
            if (manager != null) for (IContainerTooltipHandler h : new ArrayList<>(manager.instanceTooltipHandlers)) {
                handlers.add(
                    h.getClass()
                        .getName());
            }
            return null;
        }, 60);
        AiPlayerMod.LOG.info(
            "export: reading {} tooltips ({}, Shift {})",
            total,
            layout == null ? "as the game and NEI list them" : "as ChromaticTooltips lays them out",
            keys ? "can be held" : "cannot be held here");

        int with = 0, withShift = 0, withCtrl = 0, lines = 0, failed = 0, longest = 0, cutShort = -1;
        JsonArray errors = new JsonArray();
        long deadline = t0 + BUDGET_MS, lastLog = t0;
        Tip[] tips = new Tip[total];
        JsonObject checked;
        try {
            for (int first = 0; first < total; first += BATCH) {
                if (System.currentTimeMillis() > deadline) {
                    cutShort = first;
                    AiPlayerMod.LOG.warn("export: tooltips cut short at {} of {}, out of time", first, total);
                    break;
                }
                final int count = Math.min(BATCH, total - first);
                final ItemStack[] stacks = new ItemStack[count];
                for (int k = 0; k < count; k++) stacks[k] = rows.stack(first + k);
                System.arraycopy(onClient(() -> batch(stacks, keys, true), 300), 0, tips, first, count);
                long now = System.currentTimeMillis();
                if (now - lastLog >= 5000) {
                    lastLog = now;
                    AiPlayerMod.LOG.info("export: tooltips {} of {}, {} s", first + count, total, (now - t0) / 1000);
                }
            }
            checked = cutShort < 0 ? again(rows, tips, keys) : null;
        } finally {
            try {
                onClient(() -> {
                    hover.close();
                    return null;
                }, 60);
            } catch (Throwable ignored) {}
        }

        File part = new File(dir, "tooltips.jsonl.part");
        File probed = new File(dir, "tooltips-probe.jsonl");
        try (Writer w = writer(part); Writer p = probe ? writer(probed) : null) {
            for (int i = 0; i < total; i++) {
                Tip t = tips[i];
                if (t == null) continue;
                if (t.error != null) {
                    failed++;
                    if (errors.size() < ERRORS_KEPT) {
                        JsonArray e = new JsonArray();
                        e.add(new JsonPrimitive(i));
                        e.add(new JsonPrimitive(t.error));
                        errors.add(e);
                    }
                }
                if (p != null && t.probe != null) {
                    t.probe.addProperty("row", i);
                    t.probe.addProperty("id", rows.ids.get(i));
                    t.probe.addProperty("meta", rows.metas.get(i));
                    p.write(t.probe.toString());
                    p.write('\n');
                }
                JsonObject o = line(rows, i, t);
                if (o == null) continue;
                w.write(o.toString());
                w.write('\n');
                with++;
                int n = o.getAsJsonArray("tip")
                    .size();
                if (o.has("shift")) {
                    withShift++;
                    n = Math.max(
                        n,
                        o.getAsJsonArray("shift")
                            .size());
                    lines += o.getAsJsonArray("shift")
                        .size();
                }
                if (o.has("ctrl")) {
                    withCtrl++;
                    n = Math.max(
                        n,
                        o.getAsJsonArray("ctrl")
                            .size());
                    lines += o.getAsJsonArray("ctrl")
                        .size();
                }
                lines += o.getAsJsonArray("tip")
                    .size();
                longest = Math.max(longest, n);
            }
        }
        Files.move(part.toPath(), new File(dir, "tooltips.jsonl").toPath(), StandardCopyOption.REPLACE_EXISTING);

        JsonObject o = new JsonObject();
        o.addProperty("format", 1);
        o.addProperty("generatedAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX").format(new java.util.Date()));
        o.addProperty(
            "lang",
            mc.getLanguageManager()
                .getCurrentLanguage()
                .getLanguageCode());
        o.addProperty("itemsSha1", rows.sha1);
        o.addProperty("rows", total);
        o.addProperty("items", with);
        o.addProperty("shift", withShift);
        o.addProperty("ctrl", withCtrl);
        o.addProperty("lines", lines);
        o.addProperty("longest", longest);
        o.addProperty("source", layout == null ? "nei" : "chromatictooltips");
        o.addProperty("shiftHeld", keys);
        o.add("neiHandlers", array(handlers));
        o.addProperty("failed", failed);
        if (errors.size() > 0) o.add("errors", errors);
        if (cutShort >= 0) o.addProperty("cutShort", cutShort);
        if (!holds.isEmpty()) o.add("offersKey", counts(holds));
        if (!pictures.isEmpty()) o.add("pictures", counts(pictures));
        if (checked != null) o.add("checked", checked);
        long ms = System.currentTimeMillis() - t0;
        o.addProperty("seconds", Math.round(ms / 100.0) / 10.0);
        File tmp = new File(dir, "tooltips.json.part");
        Files.write(tmp.toPath(), o.toString().getBytes(StandardCharsets.UTF_8));
        Files.move(tmp.toPath(), summary.toPath(), StandardCopyOption.REPLACE_EXISTING);
        AiPlayerMod.LOG.info(
            "export: {} of {} items have a tooltip, {} another one with Shift, {} with Ctrl, {} lines, {} failed, in {} s ({} s of it on the client thread)",
            with,
            total,
            withShift,
            withCtrl,
            lines,
            failed,
            ms / 1000,
            workNanos / 1000000000L);
        return o;
    }

    /** What tooltips.jsonl says about one item; null when it has no tooltip. */
    private static JsonObject line(ItemRows rows, int i, Tip t) {
        List<String> tip = t.plain == null ? new ArrayList<String>() : t.plain;
        // The same lines in another order (the parts of a tooltip change places with a key held) say nothing new.
        boolean shift = t.shift != null && !t.shift.isEmpty() && !sameLines(t.shift, tip);
        boolean ctrl = t.ctrl != null && !t.ctrl.isEmpty() && !sameLines(t.ctrl, tip);
        if (tip.isEmpty() && !shift && !ctrl) return null;
        JsonObject o = new JsonObject();
        o.addProperty("id", rows.ids.get(i));
        o.addProperty("meta", rows.metas.get(i));
        o.add("tip", array(tip));
        if (shift) o.add("shift", array(t.shift));
        if (ctrl) o.add("ctrl", array(t.ctrl));
        return o;
    }

    /**
     * Reads some of the tooltips a second time the slow way, one item and then a tick of the game like a player
     * moving the mouse, and says how many came out differently from the fast way above. Mods keep things from one
     * tick to the next (which guide page belongs to the item under the mouse, for one); reading thousands of
     * items within one tick only gives the right lines as long as each of those is known and handled, and this
     * is how a new one gets noticed.
     */
    private JsonObject again(ItemRows rows, Tip[] tips, boolean keys) throws Exception {
        int total = rows.size(), n = 0, different = 0;
        JsonArray examples = new JsonArray();
        counting = false;
        try {
            for (int k = 0; k < CHECKED; k++) {
                // Spread over the whole list, and not in step with the batches.
                int i = (int) ((k * (long) total) / CHECKED) + k % 7;
                if (i >= total || tips[i] == null) continue;
                final ItemStack stack = rows.stack(i);
                if (stack == null) continue;
                // Not before the game has made a tick since the item before this one.
                Tip slow = null;
                for (int tries = 0; slow == null && tries < 400; tries++) {
                    final int before = tick;
                    slow = onClient(() -> {
                        int now = mc.thePlayer == null ? before + 1 : mc.thePlayer.ticksExisted;
                        if (now == before) return null;
                        tick = now;
                        return batch(new ItemStack[] { stack }, keys, false)[0];
                    }, 60);
                    if (slow == null) Thread.sleep(15);
                }
                if (slow == null) continue;
                n++;
                JsonObject fast = line(rows, i, tips[i]), careful = line(rows, i, slow);
                if (String.valueOf(fast)
                    .equals(String.valueOf(careful))) continue;
                different++;
                if (examples.size() < 20) {
                    JsonObject e = new JsonObject();
                    e.addProperty("row", i);
                    e.add("fast", fast == null ? new JsonObject() : fast);
                    e.add("slow", careful == null ? new JsonObject() : careful);
                    examples.add(e);
                }
            }
        } finally {
            counting = true;
        }
        JsonObject o = new JsonObject();
        o.addProperty("items", n);
        o.addProperty("different", different);
        if (examples.size() > 0) o.add("examples", examples);
        if (different > 0) AiPlayerMod.LOG.warn("export: {} of {} tooltips read a second time, slowly, came out differently", different, n);
        return o;
    }

    private Writer writer(File f) throws Exception {
        return new BufferedWriter(new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8), 1 << 16);
    }

    private static boolean sameLines(List<String> a, List<String> b) {
        List<String> x = new ArrayList<>(a), y = new ArrayList<>(b);
        x.removeIf(String::isEmpty);
        y.removeIf(String::isEmpty);
        java.util.Collections.sort(x);
        java.util.Collections.sort(y);
        return x.equals(y);
    }

    private static JsonArray array(List<String> lines) {
        JsonArray a = new JsonArray();
        for (String s : lines) a.add(new JsonPrimitive(s));
        return a;
    }

    private static JsonObject counts(Map<String, Integer> m) {
        JsonObject o = new JsonObject();
        for (Map.Entry<String, Integer> e : m.entrySet()) o.addProperty(e.getKey(), e.getValue());
        return o;
    }

    // ---- on the client thread -------------------------------------------------------------------------------

    private Tip[] batch(ItemStack[] stacks, boolean keys, boolean fast) {
        long t0 = System.nanoTime();
        Tip[] out = new Tip[stacks.length];
        hover.aim();
        try {
            for (int k = 0; k < stacks.length; k++) {
                Tip t = out[k] = new Tip();
                ItemStack stack = stacks[k];
                if (stack == null) {
                    t.error = "no such item";
                    continue;
                }
                hover.over(stack);
                hover.keys();
                if (fast) nextTick();
                t.error = itsOwnFault(stack);
                try {
                    t.plain = read(stack, "none", t);
                } catch (Throwable e) {
                    if (t.error == null) t.error = describe(e);
                }
                if (!keys) continue;
                hover.keys(Keyboard.KEY_LSHIFT);
                try {
                    t.shift = read(stack, "shift", t);
                } catch (Throwable e) {
                    if (t.error == null) t.error = "with Shift: " + describe(e);
                }
                // With Ctrl this pack shows the ore dictionary names of an item (items.jsonl has those) in place
                // of everything else. Only an item without such names still shows lines of its own then, and a
                // few mods have other ones for that key (the parts of a wand, of a tool).
                hover.keys(Keyboard.KEY_LCONTROL);
                try {
                    List<String> ctrl = read(stack, "ctrl", t);
                    if (!oreNames) t.ctrl = ctrl;
                } catch (Throwable ignored) {}
                if (!probe) continue;
                // Only to learn whether Alt is used for anything; none of it goes into the export.
                try {
                    hover.keys(Keyboard.KEY_LMENU);
                    read(stack, "alt", t);
                } catch (Throwable ignored) {}
            }
        } finally {
            hover.over(null);
            hover.keysBack();
            hover.mouseBack();
            workNanos += System.nanoTime() - t0;
        }
        return out;
    }

    /**
     * What mods keep from one tick of the game to the next and only renew for the first tooltip after a tick,
     * put where a tick would have put it: within one visit to the client thread no tick goes by, however many
     * items are looked at. GuideNH finds the guide page of the item under the mouse that way (its hint, "hold G
     * to open the guide", is on the items that have a page); left alone, every item of a batch would get the
     * answer of the first one.
     */
    private static void nextTick() {
        try {
            if (guideTick == null && !guideLooked) {
                guideLooked = true;
                guideTick = Class.forName("com.hfstudio.guidenh.client.hotkey.OpenGuideHotkey")
                    .getField("newTick");
            }
            if (guideTick != null) guideTick.setBoolean(null, true);
        } catch (Throwable ignored) {}
    }

    private static Field guideTick;
    private static boolean guideLooked;

    /**
     * The item's own lines and Forge's event once more, only to hear about what goes wrong in them: the game shows
     * what it got up to there and says nothing, and so does everything that builds on it.
     */
    private String itsOwnFault(ItemStack stack) {
        try {
            List<String> list = new ArrayList<>();
            list.add("");
            ItemStack copy = stack.copy();
            copy.getItem()
                .addInformation(copy, mc.thePlayer, list, false);
            ForgeEventFactory.onItemTooltip(copy, (EntityPlayer) mc.thePlayer, list, false);
            return null;
        } catch (Throwable t) {
            return describe(t);
        }
    }

    private static String describe(Throwable t) {
        while (t instanceof java.lang.reflect.InvocationTargetException && t.getCause() != null) t = t.getCause();
        String s = String.valueOf(t);
        StackTraceElement[] at = t.getStackTrace();
        if (at != null && at.length > 0) s += " at " + at[0];
        return s.length() > 300 ? s.substring(0, 300) : s;
    }

    /** The lines under the name with the keys that are held right now. */
    private List<String> read(ItemStack stack, String key, Tip t) throws Exception {
        oreNames = false;
        if (layout == null) return listed(stack);
        List<Section> sections = layout.sections(stack, counting ? pictures : new TreeMap<String, Integer>());
        List<String> body = new ArrayList<>();
        JsonArray all = probe ? new JsonArray() : null;
        for (Section s : sections) {
            if ("body".equals(s.place)) {
                body.addAll(s.lines);
                if ("oreDictionary".equals(s.id)) oreNames = true;
            }
            if (all != null) {
                JsonObject o = new JsonObject();
                o.addProperty("place", s.place);
                o.addProperty("id", s.id);
                o.add("lines", array(s.lines));
                all.add(o);
            }
        }
        if (counting && "none".equals(key)) for (String m : layout.offered) holds.merge(m, 1, Integer::sum);
        if (all != null) {
            if (t.probe == null) t.probe = new JsonObject();
            t.probe.add(key, all);
            if ("none".equals(key)) {
                JsonArray offers = new JsonArray();
                for (String m : layout.offered) offers.add(new JsonPrimitive(m));
                t.probe.add("offers", offers);
            }
        }
        // Blank lines only space the picture out; at either end they say nothing.
        while (!body.isEmpty() && body.get(0)
            .isEmpty()) body.remove(0);
        while (!body.isEmpty() && body.get(body.size() - 1)
            .isEmpty()) body.remove(body.size() - 1);
        return body;
    }

    /** Without ChromaticTooltips: the list the game makes, then NEI's handlers for the open screen, name dropped. */
    private List<String> listed(ItemStack stack) {
        GuiContainer gui = hover.screen();
        List<String> list = GuiContainerManager.itemDisplayNameMultiline(stack, gui, true);
        GuiContainerManager manager = GuiContainerManager.getManager();
        if (manager != null && gui != null) {
            // Where the mouse is in the screen's own units, worked out as the game does it.
            ScaledResolution res = new ScaledResolution(mc, mc.displayWidth, mc.displayHeight);
            int mx = Mouse.getX() * res.getScaledWidth() / mc.displayWidth;
            int my = res.getScaledHeight() - Mouse.getY() * res.getScaledHeight() / mc.displayHeight - 1;
            for (IContainerTooltipHandler h : new ArrayList<>(manager.instanceTooltipHandlers)) {
                list = h.handleItemTooltip(gui, stack, mx, my, list);
            }
        }
        List<String> out = new ArrayList<>();
        for (int i = 1; i < list.size(); i++) {
            String line = list.get(i);
            // NEI marks lines that are drawn by a handler of its own (pictures) this way; they have no text.
            if (line != null && line.startsWith("\u00a7x")) {
                pictures.merge("NEI line handler", 1, Integer::sum);
                continue;
            }
            out.add(plain(line));
        }
        return out;
    }

    /** A line without its colour and style codes (any character after the section sign), right end trimmed. */
    static String plain(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\u00a7') {
                i++;
                continue;
            }
            if (c == '\r') continue;
            sb.append(c == '\t' ? ' ' : c);
        }
        int end = sb.length();
        while (end > 0 && Character.isWhitespace(sb.charAt(end - 1))) end--;
        return sb.substring(0, end);
    }

    // ---- ChromaticTooltips -----------------------------------------------------------------------------------

    /** One part of a tooltip: where it sits (header, body, footer), which part it is, and its lines. */
    static final class Section {

        final String place;
        final String id;
        final List<String> lines = new ArrayList<>();

        Section(String place, String id) {
            this.place = place;
            this.id = id;
        }
    }

    /** ChromaticTooltips, by name: builds the tooltip of a stack as the mod would show it now and reads its text. */
    static final class Layout {

        private static final String PKG = "com.slprime.chromatictooltips.";
        private Method ofItem, createContext, getSections, getSectionId, getComponents, getTarget, getOffered;
        private Method textLines, dynamicHandler, enchantTitle, enchantHint, stats, statHasIcon, statText;
        private Constructor<?> newRequest, newLines;
        private Class<?> section, text, dynamic, enchant, inline, attribute, dividerText, divider, paragraph, space, modifier;
        private Field inlineRows, attributeTitle, dividerTitle, modifierText;
        /** Which keys the tooltip read last said it has more for (the hints in its header): shift, ctrl, alt. */
        final List<String> offered = new ArrayList<>();

        static Layout find() {
            try {
                Layout l = new Layout();
                l.link();
                return l;
            } catch (ClassNotFoundException e) {
                return null;
            } catch (Throwable t) {
                AiPlayerMod.LOG.warn("export: ChromaticTooltips is here but not as expected, taking the plain lists", t);
                return null;
            }
        }

        private void link() throws Exception {
            Class<?> target = Class.forName(PKG + "api.TooltipTarget");
            Class<?> request = Class.forName(PKG + "api.TooltipRequest");
            Class<?> lines = Class.forName(PKG + "api.TooltipLines");
            Class<?> context = Class.forName(PKG + "api.TooltipContext");
            ofItem = target.getMethod("ofItem", ItemStack.class);
            newLines = lines.getConstructor(List.class);
            newRequest = request.getConstructor(String.class, target, lines, java.awt.Point.class);
            createContext = Class.forName(PKG + "TooltipHandler")
                .getMethod("createTooltipContext", request, context);
            getSections = context.getMethod("getSections");
            getTarget = context.getMethod("getTarget");
            getOffered = context.getMethod("getSupportedModifiers");
            section = Class.forName(PKG + "component.SectionComponent");
            getSectionId = section.getMethod("getSectionId");
            getComponents = section.getMethod("getComponents");
            text = Class.forName(PKG + "component.TextComponent");
            textLines = text.getMethod("getLines");
            dynamic = Class.forName(PKG + "component.DyncamicTextComponent");
            dynamicHandler = dynamic.getMethod("getHandler");
            enchant = Class.forName(PKG + "component.EnchantmentComponent");
            enchantTitle = enchant.getMethod("getTitle");
            enchantHint = enchant.getMethod("getHint");
            inline = Class.forName(PKG + "component.InlineComponent");
            inlineRows = field(inline, "lines");
            attribute = Class.forName(PKG + "component.ItemAttributeComponent");
            attributeTitle = field(attribute, "title");
            dividerText = Class.forName(PKG + "component.DividerTextComponent");
            dividerTitle = field(dividerText, "text");
            divider = Class.forName(PKG + "component.DividerComponent");
            paragraph = Class.forName(PKG + "component.ParagraphComponent");
            space = Class.forName(PKG + "component.SpaceComponent");
            modifier = Class.forName(PKG + "component.KeyboardModifierComponent");
            modifierText = field(modifier, "text");
            stats = Class.forName(PKG + "enricher.ItemStatsEnricher")
                .getMethod("getAttributeModifiers", target);
            Class<?> stat = Class.forName(PKG + "api.ItemStats");
            statHasIcon = stat.getMethod("hasIcon");
            statText = stat.getMethod("getTextLine");
        }

        private static Field field(Class<?> c, String name) throws Exception {
            Field f = c.getDeclaredField(name);
            f.setAccessible(true);
            return f;
        }

        /** The tooltip of the stack, as it is with the keys held right now, part by part and top to bottom. */
        List<Section> sections(ItemStack stack, Map<String, Integer> pictures) throws Exception {
            Object request = newRequest.newInstance(null, ofItem.invoke(null, stack), newLines.newInstance(new ArrayList<String>()), null);
            Object context = createContext.invoke(null, request, null);
            offered.clear();
            for (Object m : (Collection<?>) getOffered.invoke(context)) offered.add(String.valueOf(m)
                .toLowerCase());
            List<Section> out = new ArrayList<>();
            for (Object place : (List<?>) getSections.invoke(context)) {
                String where = (String) getSectionId.invoke(place);
                Section loose = null;
                for (Object part : (List<?>) getComponents.invoke(place)) {
                    if (!section.isInstance(part)) {
                        // Added to the tooltip after its sections were made (NEI's pictures of recipes, for one).
                        if (loose == null) out.add(loose = new Section(where, ""));
                        read(part, loose.lines, pictures);
                        continue;
                    }
                    loose = null;
                    Section s = new Section(where, (String) getSectionId.invoke(part));
                    if ("stats:icons".equals(s.id)) {
                        // A row of little pictures, each with a number. The same facts have a line of text each
                        // (the mod shows those instead while Shift is held, and searches by them); take those.
                        for (Object stat : (List<?>) stats.invoke(null, getTarget.invoke(context))) {
                            if (!(Boolean) statHasIcon.invoke(stat)) continue;
                            String line = (String) statText.invoke(stat);
                            if (line != null) s.lines.add(plain(line));
                        }
                    } else {
                        read(part, s.lines, pictures);
                    }
                    if (!s.lines.isEmpty()) out.add(s);
                }
            }
            return out;
        }

        private void read(Object c, List<String> out, Map<String, Integer> pictures) throws Exception {
            if (c == null) return;
            if (section.isInstance(c)) {
                for (Object part : (List<?>) getComponents.invoke(c)) read(part, out, pictures);
            } else if (text.isInstance(c)) {
                for (Object line : (List<?>) textLines.invoke(c)) out.add(plain((String) line));
            } else if (dynamic.isInstance(c)) {
                Object now = ((Supplier<?>) dynamicHandler.invoke(c)).get();
                if (now != null) for (String line : String.valueOf(now)
                    .split("\n")) out.add(plain(line));
            } else if (enchant.isInstance(c)) {
                out.add(plain((String) enchantTitle.invoke(c)));
                Object hint = enchantHint.invoke(c);
                if (hint != null) for (Object line : (List<?>) hint) out.add(plain((String) line));
            } else if (inline.isInstance(c)) {
                // Things side by side; one line for each row of them.
                for (Object row : (List<?>) inlineRows.get(c)) {
                    List<String> parts = new ArrayList<>();
                    for (Object part : (List<?>) row) read(part, parts, pictures);
                    StringBuilder sb = new StringBuilder();
                    for (String p : parts) {
                        if (p.isEmpty()) continue;
                        if (sb.length() > 0 && !Character.isWhitespace(sb.charAt(sb.length() - 1)) && !Character.isWhitespace(p.charAt(0))) sb.append(' ');
                        sb.append(p);
                    }
                    if (sb.length() > 0) out.add(sb.toString());
                }
            } else if (attribute.isInstance(c)) {
                out.add(plain((String) attributeTitle.get(c)));
            } else if (dividerText.isInstance(c)) {
                out.add(plain((String) dividerTitle.get(c)));
            } else if (divider.isInstance(c)) {
                out.add("---");
            } else if (paragraph.isInstance(c)) {
                out.add("");
            } else if (space.isInstance(c)) {
                // Room between lines.
            } else if (modifier.isInstance(c)) {
                String hint = plain((String) modifierText.get(c));
                if (!hint.isEmpty()) out.add(hint);
            } else {
                // Something that is drawn, not written: an item, a recipe, a bar.
                String name = c.getClass()
                    .getName();
                pictures.merge(name.substring(name.lastIndexOf('.') + 1), 1, Integer::sum);
            }
        }
    }
}
