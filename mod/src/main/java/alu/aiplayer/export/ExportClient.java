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
 * waits for NEI to finish reading the game, runs {@link NeiExport} and closes the game.
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
        if (mc.theWorld == null || mc.thePlayer == null) {
            inWorldSince = -1;
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
        Thread t = new Thread(() -> {
            boolean ok = false;
            try {
                NeiExport.run(dir);
                ok = true;
            } catch (Throwable e) {
                AiPlayerMod.LOG.error("export: failed", e);
            }
            AiPlayerMod.LOG.info("export: {}, closing the game", ok ? "finished" : "did not finish");
            Minecraft.getMinecraft()
                .shutdown();
        }, "aiplayer-export");
        t.setDaemon(true);
        t.start();
    }
}
