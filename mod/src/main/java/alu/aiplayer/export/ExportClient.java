package alu.aiplayer.export;

import java.io.File;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.client.multiplayer.GuiConnecting;
import net.minecraft.client.multiplayer.ServerData;

import alu.aiplayer.AiPlayerMod;
import codechicken.nei.ItemList;
import codechicken.nei.NEIClientConfig;
import codechicken.nei.recipe.GuiCraftingRecipe;
import cpw.mods.fml.client.FMLClientHandler;
import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;

/**
 * Drives a client that was started only to export (tools/client): joins the given server from the title screen,
 * waits for NEI to finish reading the game, runs {@link NeiExport} and {@link IconExport} and closes the game.
 * {@code -Daiplayer.export.only=names} or {@code =icons} does just that part, from the items.jsonl already there.
 * <p>
 * Joining is done from here because the game's own {@code --server} argument trips over Forge in this version.
 * Only installed when the game was started with {@code -Daiplayer.export=<directory>}.
 */
public final class ExportClient {

    private final File dir;
    private final String join;
    private int ticks;
    private int joinAttempts;
    private int nextJoinAt = 100;
    private int inWorldSince = -1;
    private int pagesSeen = -1;
    private int pagesStableSince;
    private boolean started;
    private final boolean namesOnly = "names".equals(System.getProperty("aiplayer.export.only"));
    private final boolean iconsOnly = "icons".equals(System.getProperty("aiplayer.export.only"));

    private ExportClient(File dir, String join) {
        this.dir = dir;
        this.join = join;
    }

    public static void install() {
        String dir = System.getProperty("aiplayer.export");
        if (dir == null || dir.isEmpty()) return;
        FMLCommonHandler.instance()
            .bus()
            .register(new ExportClient(new File(dir), System.getProperty("aiplayer.export.join")));
        AiPlayerMod.LOG.info("export: will write NEI's items and recipes to {}", dir);
    }

    @SubscribeEvent
    public void tick(TickEvent.ClientTickEvent event) {
        if (event.phase != TickEvent.Phase.END || started) return;
        ticks++;
        Minecraft mc = Minecraft.getMinecraft();
        if (namesOnly) {
            // Names need no world, only a game that has finished starting.
            if (mc.currentScreen == null || ticks < 100) return;
            started = true;
            work();
            return;
        }
        if (mc.theWorld == null || mc.thePlayer == null) {
            inWorldSince = -1;
            // A handshake that hangs never comes back; better to end here and let whoever started us try again.
            if (join != null && joinAttempts > 0 && mc.currentScreen instanceof GuiConnecting && ticks > nextJoinAt + 4200) {
                AiPlayerMod.LOG.error("export: still not in the world five minutes after joining, giving up");
                started = true;
                try {
                    new File(dir, "export.failed").createNewFile();
                } catch (Throwable ignored) {}
                mc.shutdown();
                return;
            }
            // The pack has a title screen of its own, so "not busy connecting" is the test rather than a class.
            boolean idle = mc.currentScreen != null && !(mc.currentScreen instanceof GuiConnecting);
            if (join != null && idle && ticks >= nextJoinAt) {
                if (++joinAttempts > 5) {
                    AiPlayerMod.LOG.error("export: could not join {} after five attempts, giving up", join);
                    started = true;
                    mc.shutdown();
                    return;
                }
                nextJoinAt = ticks + 600;
                AiPlayerMod.LOG.info("export: joining {} (attempt {})", join, joinAttempts);
                // What the multiplayer screen does before it connects; without it Forge has nowhere to keep
                // what the server says about itself.
                FMLClientHandler.instance()
                    .setupServerList();
                FMLClientHandler.instance()
                    .connectToServer(new GuiMainMenu(), new ServerData("export", join));
            }
            return;
        }
        if (inWorldSince < 0) {
            inWorldSince = ticks;
            pagesSeen = -1;
        }
        if (ticks % 20 != 0) return;
        if (iconsOnly) {
            // Drawing needs the item list (for the stacks NEI shows) but none of the recipe pages.
            if (!NEIClientConfig.isLoaded() || !ItemList.loadFinished || ticks - inWorldSince < 300) return;
            started = true;
            work();
            return;
        }
        // NEI reads items and recipe pages in the background after the world is there. It has no single "done"
        // flag for the pages, so wait until their number has stopped changing for a while.
        int pages = GuiCraftingRecipe.craftinghandlers.size() + GuiCraftingRecipe.serialCraftingHandlers.size();
        if (pages != pagesSeen) {
            pagesSeen = pages;
            pagesStableSince = ticks;
        }
        boolean ready = NEIClientConfig.isLoaded() && ItemList.loadFinished
            && pages > 0
            && ticks - pagesStableSince >= 600
            && ticks - inWorldSince >= 1200;
        if (!ready) return;
        started = true;
        work();
    }

    private void work() {
        Thread t = new Thread(() -> {
            boolean ok = false;
            try {
                if (namesOnly) NeiExport.names(dir);
                else if (iconsOnly) IconExport.run(dir);
                else NeiExport.run(dir);
                ok = true;
            } catch (Throwable e) {
                AiPlayerMod.LOG.error("export: failed", e);
            }
            try {
                // Read by tools/export-packdata, which cannot tell a finished run from a crash otherwise.
                new File(dir, ok ? "export.ok" : "export.failed").createNewFile();
            } catch (Throwable ignored) {}
            if (ok && !namesOnly && !iconsOnly) {
                // After the mark on purpose: the icons are an extra, and whatever drawing 60,000 items of 300 mods
                // does to the game, the export above is already safe. icons/icons.json says whether they got done.
                try {
                    IconExport.run(dir);
                } catch (Throwable e) {
                    AiPlayerMod.LOG.error("export: the item icons could not be drawn", e);
                }
            }
            AiPlayerMod.LOG.info("export: {}, closing the game", ok ? "finished" : "did not finish");
            // A client thread that an item's drawing left hanging would never get to the shutdown asked for here.
            Thread last = new Thread(() -> {
                try {
                    Thread.sleep(90_000L);
                } catch (InterruptedException ignored) {}
                AiPlayerMod.LOG.error("export: the game did not close by itself, ending it");
                FMLCommonHandler.instance()
                    .exitJava(0, true);
            }, "aiplayer-export-exit");
            last.setDaemon(true);
            last.start();
            Minecraft.getMinecraft()
                .shutdown();
        }, "aiplayer-export");
        t.setDaemon(true);
        t.start();
    }
}
