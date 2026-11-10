package alu.aiplayer.task;

import java.util.LinkedHashMap;
import java.util.Map;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Reach;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * Takes an item in hand and right-clicks with it: in the air (eat, drink, put on something worn, open what the
 * item opens) or on a block. What that does is the item's business; the task reports what changed, so that the
 * caller can tell. This is the player's one general way of using a thing, for all the things nobody wrote a
 * special task for.
 */
public final class UseTask extends Task {

    private static final int SETTLE = 6;
    private static final int LONGEST_USE = 20 * 8;

    private final ItemFilter item;
    private final int[] on;
    private final boolean sneak;

    private Navigator nav;
    private int stage;
    private int wait;
    private Map<String, Integer> before;
    private String heldBefore;
    private boolean screen;
    private boolean wasSneaking;

    public UseTask(JsonObject params) {
        super("use", params);
        JsonObject it = J.object(params, "item");
        if (it == null) throw new IllegalArgumentException("item must be {id, meta?}");
        item = new ItemFilter(J.reqStr(it, "id"), J.has(it, "meta") ? J.i(it, "meta", 0) : -1, 1);
        on = J.has(params, "on") ? Params.pos(params, "on") : null;
        sneak = J.bool(params, "sneak", false);
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (on != null) {
            if (!withinTravel(on[0], on[2])) return;
            phase = "going there";
            nav = new Navigator(bot);
            nav.go(Goal.reach(on[0], on[1], on[2], false), Rules.NATURAL_ONLY, false);
        }
    }

    @Override
    public void cleanup() {
        if (nav != null) nav.stop();
        if (sneak && bot != null && bot.online()) bot.player()
            .setSneaking(wasSneaking);
    }

    @Override
    public void tick() {
        EntityPlayerMP p = bot.player();
        switch (stage) {
            case 0: {
                if (nav != null) {
                    Navigator.Status st = nav.tick();
                    if (st == Navigator.Status.WORKING) return;
                    if (st == Navigator.Status.FAILED) {
                        fail(nav.failCode, "cannot get there: " + nav.failMessage);
                        return;
                    }
                    if (!Reach.canReach(p, on[0], on[1], on[2])) {
                        fail("out_of_reach", "the block is out of reach");
                        return;
                    }
                }
                int slot = -1;
                for (int i = 0; i < Inventories.CARRY_SLOTS && slot < 0; i++) {
                    ItemStack s = p.inventory.mainInventory[i];
                    if (s != null && item.matches(s)) slot = i;
                }
                if (slot < 0) {
                    fail("no_material", "the bot carries no such item");
                    return;
                }
                if (p.openContainer != p.inventoryContainer) bot.conn()
                    .closeWindow();
                Inventories.hold(bot, slot);
                before = carried(p);
                ItemStack held = p.inventory.getCurrentItem();
                heldBefore = held == null ? null : Names.displayName(held);
                phase = "using it";
                wasSneaking = p.isSneaking();
                if (sneak) p.setSneaking(true);
                if (on != null) {
                    Motion.face(p, on[0] + 0.5, on[1] + 0.5, on[2] + 0.5);
                    bot.conn()
                        .useOnBlock(on[0], on[1], on[2], Reach.facingSide(p, on[0], on[1], on[2]), 0.5F, 0.5F, 0.5F);
                } else {
                    bot.conn()
                        .useItem();
                }
                bot.conn()
                    .swingArm();
                stage = 1;
                wait = 0;
                break;
            }
            default: {
                wait++;
                // Food and drink take a moment; the game finishes them by itself while the hand stays up.
                if (p.isUsingItem() && wait < LONGEST_USE) return;
                if (wait < SETTLE) return;
                if (sneak) p.setSneaking(wasSneaking);
                if (p.openContainer != p.inventoryContainer) {
                    // Whatever screen it opened is left to the tasks that work screens (deposit, withdraw).
                    screen = true;
                    bot.conn()
                        .closeWindow();
                }
                done();
                break;
            }
        }
    }

    private static Map<String, Integer> carried(EntityPlayerMP p) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (int i = 0; i < Inventories.CARRY_SLOTS; i++) {
            ItemStack s = p.inventory.mainInventory[i];
            if (s == null) continue;
            out.merge(Names.itemId(s.getItem()) + "@" + s.getItemDamage() + "|" + Names.displayName(s), s.stackSize, Integer::sum);
        }
        return out;
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        if (bot == null || !bot.online() || before == null) return o;
        EntityPlayerMP p = bot.player();
        Map<String, Integer> now = carried(p);
        JsonArray gained = new JsonArray(), lost = new JsonArray();
        for (Map.Entry<String, Integer> e : now.entrySet()) {
            int more = e.getValue() - (before.containsKey(e.getKey()) ? before.get(e.getKey()) : 0);
            if (more > 0) gained.add(change(e.getKey(), more));
        }
        for (Map.Entry<String, Integer> e : before.entrySet()) {
            int fewer = e.getValue() - (now.containsKey(e.getKey()) ? now.get(e.getKey()) : 0);
            if (fewer > 0) lost.add(change(e.getKey(), fewer));
        }
        // Honest about what it knows: the click was made; these are the traces it left on the bot.
        o.addProperty("used", heldBefore == null ? "nothing" : heldBefore);
        o.add("gained", gained);
        o.add("lost", lost);
        if (screen) o.addProperty("openedScreen", true);
        o.addProperty("health", J.round(p.getHealth()));
        o.addProperty(
            "food",
            p.getFoodStats()
                .getFoodLevel());
        o.addProperty("freeSlots", Inventories.freeSlots(p));
        return o;
    }

    private static JsonObject change(String key, int count) {
        JsonObject o = new JsonObject();
        int at = key.indexOf('@'), bar = key.indexOf('|');
        o.addProperty("id", key.substring(0, at));
        o.addProperty("meta", Integer.parseInt(key.substring(at + 1, bar)));
        o.addProperty("name", key.substring(bar + 1));
        o.addProperty("count", count);
        return o;
    }
}
