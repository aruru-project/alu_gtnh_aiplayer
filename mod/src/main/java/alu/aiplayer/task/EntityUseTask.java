package alu.aiplayer.task;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import net.minecraft.entity.Entity;
import net.minecraft.entity.item.EntityItem;
import net.minecraft.entity.item.EntityXPOrb;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.entity.projectile.EntityArrow;
import net.minecraft.item.ItemStack;
import net.minecraft.util.MathHelper;
import net.minecraft.util.Vec3;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.DimensionManager;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.EntityReach;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;
import alu.aiplayer.world.EntityView;

/** Walk to a stable entity identity, then make ordinary right/left clicks. No species-specific actions. */
public final class EntityUseTask extends Task {

    private final UUID uuid;
    private final int dim;
    private final ItemFilter item;
    private final boolean left, sneak;
    private final int times, every;
    private Navigator nav;
    private double gx, gy, gz;
    private int ticks, clicks, wait, events;
    private boolean settling, wasSneaking, started;
    private Entity lastTarget;
    private JsonObject entityBefore, entityAfter, heldBefore;
    private Map<String, JsonObject> inventoryBefore;
    private final Map<String, JsonObject> drops = new LinkedHashMap<>();

    public EntityUseTask(JsonObject params) {
        super("use", params);
        JsonObject target = J.object(params, "entity");
        if (target == null || !J.has(target, "dim")) throw new IllegalArgumentException("give entity {uuid,dim} from world.entities");
        uuid = EntityView.uuid(J.reqStr(target, "uuid"));
        dim = J.i(target, "dim", 0);
        if (J.has(params, "on") || J.has(params, "side") || J.has(params, "hit")) throw new IllegalArgumentException("entity is mutually exclusive with on, side and hit");
        JsonObject it = J.object(params, "item");
        item = it == null ? null : new ItemFilter(J.reqStr(it, "id"), J.has(it, "meta") ? J.i(it, "meta", 0) : -1, 1);
        left = J.bool(params, "left", false);
        sneak = J.bool(params, "sneak", false);
        times = Math.max(1, Math.min(64, J.i(params, "times", 1)));
        every = Math.max(1, Math.min(40, J.i(params, "every", 4)));
        progressTotal = times;
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        nav = new Navigator(bot);
        wasSneaking = bot.player().isSneaking();
        started = true;
        phase = "approaching entity";
    }

    /** Resolve again before every tick/click; never reuse an integer ID when the animal disappears. */
    private Entity target() {
        if (bot.player().dimension != dim) {
            fail("wrong_dimension", "target was selected in dimension " + dim + ", bot is in " + bot.player().dimension);
            return null;
        }
        Entity e = EntityView.find(bot.world(), uuid);
        if (e == null) {
            for (WorldServer world : DimensionManager.getWorlds()) {
                if (world.provider.dimensionId == dim) continue;
                if (EntityView.find(world, uuid) != null) {
                    fail("wrong_dimension", "target moved to dimension " + world.provider.dimensionId + "; selected in " + dim);
                    return null;
                }
            }
            fail("not_found", "target is no longer loaded/alive in dimension " + dim + ": " + uuid + "; it may have died, despawned or left loaded chunks");
            return null;
        }
        lastTarget = e;
        if (!e.isEntityAlive()) {
            fail("not_found", "target is no longer alive: " + uuid);
            return null;
        }
        if (e == bot.player()) {
            fail("invalid", "a player's crosshair cannot target the player itself");
            return null;
        }
        if (left && (e instanceof EntityItem || e instanceof EntityXPOrb || e instanceof EntityArrow)) {
            fail("invalid", "the game's entity attack packet does not allow attacking this target");
            return null;
        }
        if (!e.canBeCollidedWith()) {
            fail("invalid", "this entity cannot be targeted by the player's crosshair");
            return null;
        }
        return e;
    }

    private boolean hold(EntityPlayerMP p) {
        if (item == null) return Inventories.holdNothing(bot);
        ItemStack current = p.inventory.getCurrentItem();
        if (current != null && item.matches(current)) return true;
        for (int i = 0; i < Inventories.CARRY_SLOTS; i++) {
            ItemStack s = p.inventory.mainInventory[i];
            if (s != null && item.matches(s)) {
                Inventories.hold(bot, i);
                return true;
            }
        }
        // As with block use: after an item is consumed, further requested clicks use the remaining hand.
        return clicks > 0;
    }

    private boolean aim(Entity e) {
        gx = e.posX;
        gy = e.posY;
        gz = e.posZ;
        if (!withinTravel(MathHelper.floor_double(gx), MathHelper.floor_double(gz))) return false;
        nav.go(EntityReach.goal(bot.world(), e, left), Rules.NATURAL_ONLY, false);
        return true;
    }

    @Override
    public void tick() {
        EntityPlayerMP p = bot.player();
        if (settling) {
            // A lethal last click is still completed. Disappearance before another requested click is a failure.
            if (++wait < 6) return;
            if (lastTarget != null) entityAfter = EntityView.describe(lastTarget);
            done();
            return;
        }
        Entity e = target();
        if (e == null) return;
        if (wait > 0) {
            wait--;
            return;
        }
        Vec3 point = EntityReach.point(p, e, left);
        if (point == null) {
            if (++ticks > 20 * 60) {
                fail("stuck", "could not catch up to a visible, reachable target within 60 seconds of approaching; clicks made: " + clicks);
                return;
            }
            phase = "approaching entity";
            p.setSneaking(wasSneaking);
            double dx = e.posX - gx, dy = e.posY - gy, dz = e.posZ - gz;
            if (!nav.active() || (!nav.planning() && dx * dx + dy * dy + dz * dz > 1)) {
                if (!aim(e)) return;
            }
            Navigator.Status status = nav.tick();
            if (status == Navigator.Status.FAILED) {
                fail("out_of_reach", "cannot reach a visible point on target (3-block entity reach; a block or another entity may obstruct it): " + nav.failMessage);
            } else if (status == Navigator.Status.ARRIVED) {
                // Planned cell centre and actual feet differ. Centre once instead of clicking from a stale goal.
                bot.motion.moveToward(p, bot.blockX() + 0.5, bot.blockZ() + 0.5);
            }
            return;
        }
        nav.stop();
        phase = left ? "attacking entity" : "interacting with entity";
        if (p.openContainer != p.inventoryContainer) bot.conn().closeWindow();
        if (!hold(p)) {
            fail(item == null ? "inventory_full" : "no_material", item == null ? "cannot make an empty hand" : "the bot carries no such item");
            return;
        }
        p.setSneaking(sneak || wasSneaking);
        // Sneaking changes eye height in some mods: recheck the live target, not the original coordinates.
        point = EntityReach.point(p, e, left);
        if (point == null) return;
        Motion.face(p, point.xCoord, point.yCoord, point.zCoord);
        if (entityBefore == null) {
            entityBefore = EntityView.describe(e);
            inventoryBefore = inventory(p);
            ItemStack held = p.inventory.getCurrentItem();
            heldBefore = held == null ? null : Names.describe(held);
        }
        Map<String, JsonObject> beforeDrops = nearbyDrops(e);
        JsonObject receipt = bot.conn().useOnEntity(e, left);
        clicks++;
        progressDone = clicks;
        if (J.bool(receipt, "event", false)) events++;
        bot.conn().swingArm();
        entityAfter = EntityView.describe(e);
        for (Map.Entry<String, JsonObject> drop : nearbyDrops(e).entrySet()) {
            if (!beforeDrops.containsKey(drop.getKey())) drops.put(drop.getKey(), drop.getValue());
        }
        if (J.bool(receipt, "denied", false)) {
            fail("denied", "the entity interaction/attack or damage event was canceled by server protection or another mod; clicks attempted: " + clicks);
            return;
        }
        if (!J.bool(receipt, "event", false)) {
            fail("no_effect", "the normal server handler did not reach an entity interaction/attack event; no success is assumed");
            return;
        }
        boolean screen = p.openContainer != p.inventoryContainer;
        if (screen) bot.conn().closeWindow();
        openedScreen |= screen;
        if (clicks >= times || screen) {
            settling = true;
            wait = 0;
        } else wait = every - 1;
    }

    private boolean openedScreen;

    private Map<String, JsonObject> nearbyDrops(Entity target) {
        Map<String, JsonObject> out = new LinkedHashMap<>();
        for (Object o : target.worldObj.getEntitiesWithinAABB(EntityItem.class, target.boundingBox.expand(4, 4, 4))) {
            EntityItem e = (EntityItem) o;
            if (!e.isDead) out.put(e.getUniqueID().toString(), EntityView.describe(e));
        }
        return out;
    }

    private static Map<String, JsonObject> inventory(EntityPlayerMP p) {
        Map<String, JsonObject> out = new LinkedHashMap<>();
        for (int i = 0; i < Inventories.CARRY_SLOTS; i++) {
            ItemStack s = p.inventory.mainInventory[i];
            if (s == null) continue;
            String key = Names.itemId(s.getItem()) + "@" + Names.meta(s);
            JsonObject old = out.get(key);
            JsonObject next = Names.describe(s);
            if (old != null) next.addProperty("count", s.stackSize + J.i(old, "count", 0));
            out.put(key, next);
        }
        return out;
    }

    private static JsonArray difference(Map<String, JsonObject> a, Map<String, JsonObject> b) {
        JsonArray out = new JsonArray();
        for (Map.Entry<String, JsonObject> entry : a.entrySet()) {
            int n = J.i(entry.getValue(), "count", 0) - (b.containsKey(entry.getKey()) ? J.i(b.get(entry.getKey()), "count", 0) : 0);
            if (n <= 0) continue;
            JsonObject value = new JsonObject();
            for (Map.Entry<String, com.google.gson.JsonElement> field : entry.getValue().entrySet()) value.add(field.getKey(), field.getValue());
            value.addProperty("count", n);
            out.add(value);
        }
        return out;
    }

    @Override
    protected JsonObject summary() {
        JsonObject out = new JsonObject();
        out.addProperty("clicks", clicks);
        out.addProperty("entityEvents", events);
        out.addProperty("left", left);
        out.addProperty("used", heldBefore == null ? "an empty hand" : J.str(heldBefore, "name", "item"));
        out.addProperty("note", "Clicks are attempts, not a claim that the intended action succeeded. Compare target state, inventory and newly observed nearby drops.");
        if (entityBefore != null) out.add("entityBefore", entityBefore);
        if (lastTarget != null && entityBefore != null) entityAfter = EntityView.describe(lastTarget);
        if (entityAfter != null) out.add("entityNow", entityAfter);
        JsonArray dropped = new JsonArray();
        for (JsonObject e : drops.values()) dropped.add(e);
        out.add("newNearbyDrops", dropped);
        if (openedScreen) out.addProperty("openedScreen", true);
        if (inventoryBefore != null && bot != null && bot.online()) {
            Map<String, JsonObject> now = inventory(bot.player());
            out.add("gained", difference(now, inventoryBefore));
            out.add("lost", difference(inventoryBefore, now));
            if (heldBefore != null) out.add("heldBefore", heldBefore);
            ItemStack held = bot.player().inventory.getCurrentItem();
            if (held != null) out.add("heldNow", Names.describe(held));
        }
        return out;
    }

    @Override
    public void cleanup() {
        if (nav != null) nav.stop();
        if (started && bot != null && bot.online()) bot.player().setSneaking(wasSneaking);
    }
}
