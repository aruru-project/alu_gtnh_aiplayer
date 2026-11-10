package alu.aiplayer;

import net.minecraft.entity.player.EntityPlayer;
import net.minecraftforge.event.ServerChatEvent;
import net.minecraftforge.event.entity.living.LivingDeathEvent;
import net.minecraftforge.event.entity.living.LivingHurtEvent;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.BotManager;
import alu.aiplayer.bridge.BridgeServer;
import alu.aiplayer.util.J;
import cpw.mods.fml.common.eventhandler.EventPriority;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.PlayerEvent;
import cpw.mods.fml.common.gameevent.TickEvent;

/** Hooks into the server: drives bots every tick and turns game happenings into bridge events. */
public final class ServerEvents {

    private final BridgeServer bridge;
    private final BotManager bots;
    private long lastHurtEvent;

    ServerEvents(BridgeServer bridge, BotManager bots) {
        this.bridge = bridge;
        this.bots = bots;
    }

    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent event) {
        // End of tick is where the server would have handled this tick's client packets.
        if (event.phase != TickEvent.Phase.END) return;
        bridge.pump();
        bots.tick();
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onChat(ServerChatEvent event) {
        if (event.player == null) return;
        JsonObject data = new JsonObject();
        data.addProperty("player", event.username);
        data.addProperty(
            "uuid",
            event.player.getUniqueID()
                .toString());
        data.addProperty("message", event.message);
        data.addProperty("isBot", bots.isBot(event.player));
        bridge.emit("chat", data);
        // The same line is about to be delivered to every player, bots included; they need not hear it twice.
        bots.noteChatBroadcast(event.component == null ? null : event.component.getUnformattedText());
    }

    @SubscribeEvent
    public void onLogin(PlayerEvent.PlayerLoggedInEvent event) {
        emitPlayer("player.join", event.player);
    }

    @SubscribeEvent
    public void onLogout(PlayerEvent.PlayerLoggedOutEvent event) {
        emitPlayer("player.leave", event.player);
    }

    private void emitPlayer(String name, EntityPlayer player) {
        if (bots.isBot(player)) return;
        JsonObject data = new JsonObject();
        data.addProperty("player", player.getCommandSenderName());
        data.addProperty(
            "uuid",
            player.getUniqueID()
                .toString());
        bridge.emit(name, data);
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onDeath(LivingDeathEvent event) {
        if (!(event.entityLiving instanceof EntityPlayer)) return;
        Bot bot = bots.botOf((EntityPlayer) event.entityLiving);
        if (bot == null) return;
        JsonObject data = new JsonObject();
        data.addProperty("bot", bot.name);
        data.addProperty("cause", event.source == null ? "unknown" : event.source.getDamageType());
        bridge.emit("bot.death", data);
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onHurt(LivingHurtEvent event) {
        if (!(event.entityLiving instanceof EntityPlayer)) return;
        Bot bot = bots.botOf((EntityPlayer) event.entityLiving);
        if (bot == null) return;
        long now = System.currentTimeMillis();
        if (now - lastHurtEvent < 2000) return;
        lastHurtEvent = now;
        JsonObject data = new JsonObject();
        data.addProperty("bot", bot.name);
        data.addProperty("source", event.source == null ? "unknown" : event.source.getDamageType());
        data.addProperty("amount", J.round(event.ammount));
        data.addProperty("health", J.round(event.entityLiving.getHealth()));
        bridge.emit("bot.hurt", data);
    }
}
