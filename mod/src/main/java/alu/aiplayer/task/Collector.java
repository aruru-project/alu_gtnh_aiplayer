package alu.aiplayer.task;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import net.minecraft.block.material.Material;
import net.minecraft.entity.item.EntityItem;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.util.AxisAlignedBB;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.NavWorld;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.util.Names;
import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.PlayerEvent;

/** Walks or swims over dropped items in a box until none are left that the bot can carry or get to. */
public final class Collector {

    private final Bot bot;
    private final AxisAlignedBB box;
    private final NavWorld.BreakRule rule;
    private final Navigator nav;
    private final Map<Integer, String> givenUp = new HashMap<>();
    private final Set<Integer> pickedIds = new HashSet<>();
    private EntityItem target;
    private AxisAlignedBB destination;
    private ItemStack targetStack;
    private int waitTicks;
    private int ticksLeft;
    int picked;
    int disappeared;
    String failCode;
    String failMessage;
    private boolean stopped;
    private final boolean mayPillar;

    Collector(Bot bot, AxisAlignedBB box, NavWorld.BreakRule rule, int maxTicks, boolean mayPillar) {
        this.mayPillar = mayPillar;
        this.bot = bot;
        this.box = box;
        this.rule = rule;
        this.nav = new Navigator(bot);
        this.ticksLeft = maxTicks;
        FMLCommonHandler.instance().bus().register(this);
    }

    /** The game's successful pickup event, not isDead (which also means merged, despawned, or someone else took it). */
    @SubscribeEvent
    public void pickedUp(PlayerEvent.ItemPickupEvent e) {
        if (e.player != bot.player() || !e.pickedUp.boundingBox.intersectsWith(box)) return;
        if (pickedIds.add(e.pickedUp.getEntityId())) picked++;
    }

    /** Returns true while there is more to pick up. */
    boolean tick() {
        if (--ticksLeft <= 0) return end("stuck", "collection timed out; see remaining items");
        EntityPlayerMP p = bot.player();
        // Being able to swim somewhere does not mean being able to breathe there. Do not silently drown while
        // retrying a path. Death/dimension changes are also interrupted by the bot's ordinary task driver.
        if (!bot.invulnerable && p.isInsideOfMaterial(Material.water) && p.getAir() < 80) {
            return end("interrupted", "air running low underwater; collection stopped here, not back at the surface");
        }
        if (target != null && target.isDead) {
            if (!pickedIds.contains(target.getEntityId()) && !mergedNearby()) disappeared++;
            target = null;
            nav.stop();
        }
        if (target != null && (!target.boundingBox.intersectsWith(box) || !hasRoomFor(p, target.getEntityItem()))) {
            givenUp.put(target.getEntityId(), "left collection area or no room");
            if (!target.boundingBox.intersectsWith(box)) disappeared++;
            target = null;
            nav.stop();
        }
        if (target == null) {
            target = nearest(p);
            if (target == null) {
                if (disappeared > 0) return end("interrupted", "an item target disappeared without a confirmed pickup");
                if (remaining().size() > 0) return end("unreachable", "items remain; see their positions and reasons");
                stop();
                return false;
            }
            targetStack = target.getEntityItem().copy();
            plan(p);
        } else if (moved()) {
            // Items fall, flow and merge. Never keep walking to a stale rounded position.
            plan(p);
        }
        Navigator.Status st = nav.tick();
        if (st == Navigator.Status.FAILED) {
            givenUp.put(target.getEntityId(), nav.failCode + ": " + nav.failMessage);
            target = null;
        } else if (st == Navigator.Status.ARRIVED) {
            if (!Goal.pickup(p, target.boundingBox).reached(p)) {
                plan(p);
            } else if (++waitTicks > 50) {
                givenUp.put(target.getEntityId(), "in pickup range but not picked up (delay, owner or server rules)");
                target = null;
            }
        }
        return true;
    }

    private void plan(EntityPlayerMP p) {
        destination = target.boundingBox.copy();
        waitTicks = 0;
        nav.go(Goal.pickup(p, destination), rule, mayPillar, true);
    }

    private boolean moved() {
        AxisAlignedBB b = target.boundingBox;
        return Math.abs(b.minX - destination.minX) > 0.5 || Math.abs(b.minY - destination.minY) > 0.5
            || Math.abs(b.minZ - destination.minZ) > 0.5;
    }

    private boolean mergedNearby() {
        for (Object o : bot.player().worldObj.getEntitiesWithinAABB(EntityItem.class, target.boundingBox.expand(1, 0.5, 1))) {
            EntityItem e = (EntityItem) o;
            ItemStack s = e.getEntityItem();
            if (!e.isDead && s != null && s.isItemEqual(targetStack) && ItemStack.areItemStackTagsEqual(s, targetStack)
                && s.stackSize >= targetStack.stackSize) return true;
        }
        return false;
    }

    private boolean end(String code, String message) {
        failCode = code;
        failMessage = message;
        stop();
        return false;
    }

    void stop() {
        nav.stop();
        if (!stopped) FMLCommonHandler.instance().bus().unregister(this);
        stopped = true;
    }

    JsonArray remaining() {
        JsonArray out = new JsonArray();
        EntityPlayerMP p = bot.player();
        for (Object o : p.worldObj.getEntitiesWithinAABB(EntityItem.class, box)) {
            EntityItem e = (EntityItem) o;
            ItemStack s = e.getEntityItem();
            if (e.isDead || s == null) continue;
            JsonObject item = new JsonObject();
            item.addProperty("entityId", e.getEntityId());
            item.addProperty("id", Names.itemId(s.getItem()));
            item.addProperty("meta", s.getItemDamage());
            item.addProperty("count", s.stackSize);
            item.addProperty("x", e.posX);
            item.addProperty("y", e.posY);
            item.addProperty("z", e.posZ);
            String reason = givenUp.get(e.getEntityId());
            if (reason == null) reason = hasRoomFor(p, s) ? "not collected" : "no room in inventory";
            item.addProperty("reason", reason);
            out.add(item);
        }
        return out;
    }

    private EntityItem nearest(EntityPlayerMP p) {
        List<?> found = p.worldObj.getEntitiesWithinAABB(EntityItem.class, box);
        EntityItem best = null;
        double bestDist = Double.MAX_VALUE;
        for (Object o : found) {
            EntityItem e = (EntityItem) o;
            if (e.isDead || givenUp.containsKey(e.getEntityId())) continue;
            ItemStack s = e.getEntityItem();
            if (s == null || !hasRoomFor(p, s)) continue;
            double d = p.getDistanceSqToEntity(e);
            if (d < bestDist) {
                bestDist = d;
                best = e;
            }
        }
        return best;
    }

    static boolean hasRoomFor(EntityPlayerMP p, ItemStack stack) {
        if (stack == null) return false;
        ItemStack[] inv = p.inventory.mainInventory;
        for (int i = 0; i < inv.length && i < alu.aiplayer.act.Inventories.CARRY_SLOTS; i++) {
            ItemStack s = inv[i];
            if (s == null) return true;
            if (s.getItem() == stack.getItem() && s.isStackable()
                && s.stackSize < s.getMaxStackSize()
                && s.getItemDamage() == stack.getItemDamage()
                && ItemStack.areItemStackTagsEqual(s, stack)) return true;
        }
        return false;
    }
}
