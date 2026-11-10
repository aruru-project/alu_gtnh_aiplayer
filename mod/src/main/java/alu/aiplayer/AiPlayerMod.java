package alu.aiplayer;

import java.io.File;

import net.minecraftforge.common.MinecraftForge;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import alu.aiplayer.bot.BotManager;
import alu.aiplayer.bridge.BridgeApi;
import alu.aiplayer.bridge.BridgeServer;
import alu.aiplayer.world.BlueprintStore;
import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.event.FMLPreInitializationEvent;
import cpw.mods.fml.common.event.FMLServerStartedEvent;
import cpw.mods.fml.common.event.FMLServerStartingEvent;
import cpw.mods.fml.common.event.FMLServerStoppingEvent;

/**
 * Server-side only. Adds no blocks, items or network channels, so clients connect without it.
 * It keeps AI players in the world (the "body") and serves the local bridge the brain service talks to.
 */
@Mod(
    modid = AiPlayerMod.MODID,
    name = "Alu AI Player",
    version = Tags.VERSION,
    acceptedMinecraftVersions = "[1.7.10]",
    acceptableRemoteVersions = "*")
public class AiPlayerMod {

    public static final String MODID = "aiplayer";
    public static final Logger LOG = LogManager.getLogger(MODID);

    private static AiPlayerMod instance;

    private File configDir;
    private ModConfig config;
    private BridgeServer bridge;
    private BotManager bots;
    private ServerEvents events;
    private BlueprintStore blueprints;

    public AiPlayerMod() {
        instance = this;
    }

    public static BotManager bots() {
        return instance == null ? null : instance.bots;
    }

    public static ModConfig config() {
        return instance.config;
    }

    public static BlueprintStore blueprints() {
        return instance.blueprints;
    }

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        configDir = new File(event.getModConfigurationDirectory(), "aiplayer");
        config = ModConfig.load(new File(configDir, "aiplayer.json"));
        blueprints = new BlueprintStore(new File(configDir, "schematics"));
    }

    @Mod.EventHandler
    public void serverStarting(FMLServerStartingEvent event) {
        bridge = new BridgeServer(config.bridgeHost, config.bridgePort, new File(configDir, "bridge-token.txt"));
        bots = new BotManager(config, bridge);
        new BridgeApi(bridge, bots).registerAll();
        events = new ServerEvents(bridge, bots);
        MinecraftForge.EVENT_BUS.register(events);
        FMLCommonHandler.instance()
            .bus()
            .register(events);
        event.registerServerCommand(new CommandAiPlayer(bots));
    }

    @Mod.EventHandler
    public void serverStarted(FMLServerStartedEvent event) {
        bots.onServerStarted();
        bridge.start();
    }

    @Mod.EventHandler
    public void serverStopping(FMLServerStoppingEvent event) {
        if (bridge == null) return;
        bridge.emit("server.stopping", null);
        bots.onServerStopping();
        bridge.stop();
        MinecraftForge.EVENT_BUS.unregister(events);
        FMLCommonHandler.instance()
            .bus()
            .unregister(events);
        bridge = null;
        bots = null;
        events = null;
    }
}
