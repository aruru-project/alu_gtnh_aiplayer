package alu.aiplayer.task;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.entity.item.EntityItem;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.util.MathHelper;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.NavWorld;
import alu.aiplayer.nav.Navigator;

/** Walks over dropped items in a box until none are left that the bot can carry or get to. */
final class Collector {

    private final Bot bot;
    private final AxisAlignedBB box;
    private final NavWorld.BreakRule rule;
    private final Navigator nav;
    private final Set<Integer> givenUp = new HashSet<>();
    private EntityItem target;
    private int waitTicks;
    private int ticksLeft;
    int picked;

    Collector(Bot bot, AxisAlignedBB box, NavWorld.BreakRule rule, int maxTicks) {
        this.bot = bot;
        this.box = box;
        this.rule = rule;
        this.nav = new Navigator(bot);
        this.ticksLeft = maxTicks;
    }

    /** Returns true while there is more to pick up. */
    boolean tick() {
        if (--ticksLeft <= 0) {
            nav.stop();
            return false;
        }
        EntityPlayerMP p = bot.player();
        if (target != null && (target.isDead || !hasRoomFor(p, target.getEntityItem()))) {
            if (target.isDead) picked++;
            target = null;
            nav.stop();
        }
        if (target == null) {
            target = nearest(p);
            if (target == null) return false;
            waitTicks = 0;
            nav.go(
                Goal.near(
                    MathHelper.floor_double(target.posX),
                    MathHelper.floor_double(target.posY + 0.01),
                    MathHelper.floor_double(target.posZ),
                    0),
                rule);
        }
        Navigator.Status st = nav.tick();
        if (st == Navigator.Status.FAILED) {
            givenUp.add(target.getEntityId());
            target = null;
        } else if (st == Navigator.Status.ARRIVED) {
            // Standing on it; pickup happens by itself once the item's delay runs out.
            if (++waitTicks > 50) {
                givenUp.add(target.getEntityId());
                target = null;
            }
        }
        return true;
    }

    void stop() {
        nav.stop();
    }

    private EntityItem nearest(EntityPlayerMP p) {
        List<?> found = p.worldObj.getEntitiesWithinAABB(EntityItem.class, box);
        EntityItem best = null;
        double bestDist = Double.MAX_VALUE;
        for (Object o : found) {
            EntityItem e = (EntityItem) o;
            if (e.isDead || givenUp.contains(e.getEntityId())) continue;
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
        for (ItemStack s : p.inventory.mainInventory) {
            if (s == null) return true;
            if (s.getItem() == stack.getItem() && s.isStackable()
                && s.stackSize < s.getMaxStackSize()
                && s.getItemDamage() == stack.getItemDamage()
                && ItemStack.areItemStackTagsEqual(s, stack)) return true;
        }
        return false;
    }
}
