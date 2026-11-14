package alu.aiplayer.task;

import java.util.LinkedHashMap;
import java.util.Map;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Orientation;
import alu.aiplayer.act.Placer;
import alu.aiplayer.act.Reach;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * A right-click (or, with "left", a left-click on a block), the way a player makes one: with an item in hand or with an empty hand, in the air (eat, drink,
 * put on something worn, open what the item opens) or on a block, on the face and at the point of it the caller
 * chooses, once or several times in a row, sneaking or not. What that does is the item's and the block's
 * business; the task reports what changed, so that the caller can tell. This is the player's one general way of
 * using a thing, for all the things nobody wrote a special task for.
 */
public final class UseTask extends Task {

    private static final int SETTLE = 6;
    private static final int LONGEST_USE = 20 * 8;
    private static final int MOST_CLICKS = 64;
    private static final String[] SIDES = { "down", "up", "north", "south", "west", "east" };

    /** Null for an empty hand. */
    private final ItemFilter item;
    private final int[] on;
    private final boolean sneak;
    /** A left-click on the block: the attack button pressed and let go, as a player taps it. */
    private final boolean left;
    /** The face to click, 0 down .. 5 east; -1 for the one turned towards the bot. */
    private final int side;
    /** Where on the block, each 0..1 from its lowest corner; null for the middle of the face. */
    private final float[] hit;
    private final int times;
    private final int every;
    private final boolean currentPosition;
    private int approachTicks;

    private Navigator nav;
    private int stage;
    private int wait;
    private int clicks;
    private Map<String, Integer> before;
    private String heldBefore;
    private boolean screen;
    private boolean wasSneaking;
    /** The clicked block before the first click: id/meta. */
    private String blockBefore;
    /** Whether the walk is over (the checks after it are made once). */
    private boolean arrived;
    /**
     * The clicked block's saved data, flattened, twice before the first click (a couple of ticks apart, to tell the
     * values that change by themselves) and once after. Null when the block keeps no data.
     */
    private Map<String, String> dataEarly, dataBefore;
    private boolean dataTaken;
    private int dataWait;
    /**
     * The cell the first right-click on a block would put a block into (the clicked block itself when it gives way,
     * else the cell on the face clicked), what was there before, and whether the held item places blocks.
     */
    private int[] placeAt;
    private String placeBefore;
    private boolean heldPlacesBlock;
    /** Why the block in the hand did not go in, by the game's own checks; null when it did or nothing is known. */
    private String notPlaced;
    /**
     * The block clicked is a liquid. No click can be aimed at a liquid: a player looks at it from where it is seen,
     * the crosshair falls on the solid block behind it (or on nothing), and an item that takes liquids (a bucket, a
     * cell) finds the liquid with a look of its own. So does the bot.
     */
    private boolean liquid;
    /**
     * No place to stand was found from where the face to click is in sight (a player clicks only what it sees): the
     * click was made from within reach as before, through whatever is in front of the face; an item's own look (a
     * bucket pouring) meets what is in front.
     */
    private boolean faceUnseen;
    private Goal fallbackGoal;
    private boolean recentredForSight;
    private int recentring;
    /** The point of the liquid looked at: {face, x, y, z}, each of x, y, z 0..1 from the block's lowest corner. */
    private double[] lookPoint;
    /** For a liquid: what the first click went to (the crosshair's block), or nothing within reach. */
    private JsonObject crosshair;
    private boolean crosshairNone;
    /** Clicks after which the item was also used in the air, as a player's client does when its click came to nothing. */
    private int inAir;
    /** What the item's own look met at the first of those: the first block or liquid source. */
    private JsonObject looking;
    private boolean lookingAtNothing;
    /** The item in the hand at the first click. */
    private ItemStack heldAtFirst;

    public UseTask(JsonObject params) {
        super("use", params);
        JsonObject it = J.object(params, "item");
        item = it == null ? null : new ItemFilter(J.reqStr(it, "id"), J.has(it, "meta") ? J.i(it, "meta", 0) : -1, 1);
        on = J.has(params, "on") ? Params.pos(params, "on") : null;
        if (item == null && on == null) {
            throw new IllegalArgumentException("give item {id, meta?}, or on {x,y,z} to click a block with an empty hand, or both");
        }
        sneak = J.bool(params, "sneak", false);
        left = J.bool(params, "left", false);
        if (left && on == null) throw new IllegalArgumentException("a left click is on a block: give on {x,y,z}");
        side = side(params);
        JsonObject h = J.object(params, "hit");
        if (h == null) {
            hit = null;
        } else {
            hit = new float[] { part(h, "x"), part(h, "y"), part(h, "z") };
        }
        if ((side >= 0 || hit != null) && on == null) throw new IllegalArgumentException("side and hit belong to a block: give on {x,y,z}");
        times = Math.max(1, Math.min(MOST_CLICKS, J.i(params, "times", 1)));
        every = Math.max(1, Math.min(40, J.i(params, "every", 4)));
        String approach = J.str(params, "approach", "walk");
        if (!approach.equals("walk") && !approach.equals("current")) throw new IllegalArgumentException("approach must be walk or current");
        currentPosition = approach.equals("current");
    }

    private static int side(JsonObject params) {
        if (!J.has(params, "side")) return -1;
        String name = J.str(params, "side", "");
        for (int i = 0; i < SIDES.length; i++) if (SIDES[i].equalsIgnoreCase(name)) return i;
        throw new IllegalArgumentException("side is one of down, up, north, south, west, east");
    }

    private static float part(JsonObject h, String key) {
        float v = h.has(key) ? h.get(key)
            .getAsFloat() : 0.5F;
        if (!(v >= 0F && v <= 1F)) throw new IllegalArgumentException("hit is {x,y,z}, each from 0 to 1 across the block");
        return v;
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (on != null) {
            if (!withinTravel(on[0], on[2])) return;
            phase = "going there";
            nav = new Navigator(bot);
            nav.interaction(currentPosition);
            net.minecraft.world.World w = bot.player().worldObj;
            liquid = !left && w.blockExists(on[0], on[1], on[2]) && w.getBlock(on[0], on[1], on[2])
                .getMaterial()
                .isLiquid();
            // A face is clicked from the side it looks at.
            Goal near = side >= 2 ? Goal.reachFacing(on[0], on[1], on[2], side) : Goal.reach(on[0], on[1], on[2], false);
            Goal goal;
            if (left && !currentPosition) {
                goal = near;
            } else {
                // A player clicks what it sees: somewhere the face (a liquid: the liquid) is in sight, within reach.
                goal = alu.aiplayer.act.Sight.seeing(w, on[0], on[1], on[2], side, liquid, hit);
                if (!liquid && !currentPosition) fallbackGoal = near;
            }
            nav.go(goal, Rules.NATURAL_ONLY, false);
        }
    }

    /** One right-click. Returns false when the item asked for is not carried. */
    private boolean click(EntityPlayerMP p) {
        if (item != null) {
            ItemStack held = p.inventory.getCurrentItem();
            if (held == null || !item.matches(held)) {
                int slot = -1;
                for (int i = 0; i < Inventories.CARRY_SLOTS && slot < 0; i++) {
                    ItemStack s = p.inventory.mainInventory[i];
                    if (s != null && item.matches(s)) slot = i;
                }
                // The first click needs the item; later ones go on with what the hand holds, as a held button does.
                if (slot >= 0) Inventories.hold(bot, slot);
                else if (clicks == 0) return false;
            }
        }
        if (on == null) {
            bot.conn()
                .useItem();
        } else if (liquid) {
            clickLiquid(p);
            clicks++;
            return true;
        } else {
            int face = side >= 0 ? side : Reach.facingSide(p, on[0], on[1], on[2]);
            float[] at = hit != null ? hit : side >= 0 ? middle(face) : new float[] { 0.5F, 0.5F, 0.5F };
            if (!left && lookPoint != null) {
                // The face and the point of it that is in sight.
                face = (int) lookPoint[0];
                at = new float[] { (float) lookPoint[1], (float) lookPoint[2], (float) lookPoint[3] };
            }
            Motion.face(p, on[0] + at[0], on[1] + at[1], on[2] + at[2]);
            if (left) {
                if (item == null && !Inventories.holdNothing(bot)) return false;
                // Pressed and let go at once: whatever reacts to the press (a chisel carving the block, a note
                // block, something that breaks at a touch) does; anything that takes digging is not dug.
                bot.conn()
                    .startDigging(on[0], on[1], on[2], face);
                bot.conn()
                    .abortDigging(on[0], on[1], on[2], face);
                bot.conn()
                    .swingArm();
                clicks++;
                return true;
            }
            if (item == null) {
                alu.aiplayer.act.ContainerSession.clickEmptyHanded(bot, on[0], on[1], on[2], face, at[0], at[1], at[2]);
                clicks++;
                return true;
            }
            boolean first = clicks == 0;
            ItemStack held = p.inventory.getCurrentItem();
            ItemStack heldCopy = held == null ? null : held.copy();
            if (first) {
                heldAtFirst = heldCopy;
                placeAt = Placer.targetOfClick(p.worldObj, on[0], on[1], on[2], face);
                placeBefore = blockAt(p, placeAt);
                heldPlacesBlock = heldCopy != null && Orientation.blockOf(heldCopy.getItem()) != null;
            }
            String before = trace(p);
            bot.conn()
                .useOnBlock(on[0], on[1], on[2], face, at[0], at[1], at[2]);
            // A block in the hand that did not go in: why, by the game's own checks, while the world is as it was.
            if (first && heldPlacesBlock
                && placeBefore.equals(blockAt(p, placeAt))
                && blockBefore != null
                && blockBefore.equals(blockAt(p, on))) {
                ItemStack now = p.inventory.getCurrentItem();
                if (p.openContainer != p.inventoryContainer && !p.isSneaking()) {
                    // A block with a screen takes a right-click for itself unless the player sneaks.
                    notPlaced = "the click went to the block clicked, which opened its screen, instead of placing (a block with a screen takes the click; sneaking places against it)";
                } else if (now != null && now.stackSize == heldCopy.stackSize) {
                    notPlaced = Placer.whyNotPlaced(bot, heldCopy, placeAt[0], placeAt[1], placeAt[2], face);
                }
            }
            alsoInAir(p, before, first);
        }
        bot.conn()
            .swingArm();
        clicks++;
        return true;
    }

    /**
     * A right-click at a liquid, as a player makes it: looking at the point of it that is seen, the click goes to the
     * block the crosshair is on (liquids are looked through; it may be the block behind or under the liquid, or
     * nothing within reach), and when that comes to nothing the item is used in the air, where a bucket or a cell
     * finds the liquid along the look.
     */
    private void clickLiquid(EntityPlayerMP p) {
        boolean first = clicks == 0;
        Motion.face(p, on[0] + lookPoint[1], on[1] + lookPoint[2], on[2] + lookPoint[3]);
        net.minecraft.util.MovingObjectPosition mo = alu.aiplayer.act.Sight.crosshair(p);
        ItemStack held = p.inventory.getCurrentItem();
        if (first) {
            heldAtFirst = held == null ? null : held.copy();
            if (mo == null) crosshairNone = true;
            else crosshair = alu.aiplayer.act.Sight.json(p.worldObj, mo);
            heldPlacesBlock = held != null && Orientation.blockOf(held.getItem()) != null;
            if (mo != null && heldPlacesBlock) {
                // A block in the hand goes against the block under the crosshair.
                placeAt = Placer.targetOfClick(p.worldObj, mo.blockX, mo.blockY, mo.blockZ, mo.sideHit);
                placeBefore = blockAt(p, placeAt);
            }
        }
        String before = trace(p);
        if (mo != null) {
            float hx = (float) (mo.hitVec.xCoord - mo.blockX), hy = (float) (mo.hitVec.yCoord - mo.blockY),
                hz = (float) (mo.hitVec.zCoord - mo.blockZ);
            if (item == null) {
                alu.aiplayer.act.ContainerSession.clickEmptyHanded(bot, mo.blockX, mo.blockY, mo.blockZ, mo.sideHit, hx, hy, hz);
                return;
            }
            bot.conn()
                .useOnBlock(mo.blockX, mo.blockY, mo.blockZ, mo.sideHit, hx, hy, hz);
        }
        if (item == null) return;
        if (mo == null) {
            // Nothing under the crosshair: the client only uses the item in the air.
            useInAir(p, first);
        } else {
            alsoInAir(p, before, first);
        }
        bot.conn()
            .swingArm();
    }

    /**
     * After a click on a block with an item in the hand: when nothing at all came of it, the item is also used in the
     * air, along the same look. A player's client does that whenever its click on a block came to nothing (a bucket
     * fills or empties that way, food is eaten that way).
     */
    private void alsoInAir(EntityPlayerMP p, String before, boolean first) {
        if (p.inventory.getCurrentItem() == null || !before.equals(trace(p))) return;
        useInAir(p, first || inAir == 0);
    }

    private void useInAir(EntityPlayerMP p, boolean record) {
        if (record && looking == null && !lookingAtNothing) {
            net.minecraft.util.MovingObjectPosition mo = alu.aiplayer.act.Sight.itemRay(p);
            if (mo == null) lookingAtNothing = true;
            else looking = alu.aiplayer.act.Sight.json(p.worldObj, mo);
        }
        inAir++;
        bot.conn()
            .useItem();
    }

    /** Everything a click could visibly change: what the bot carries and holds, the blocks concerned, a screen. */
    private String trace(EntityPlayerMP p) {
        StringBuilder sb = new StringBuilder();
        sb.append(carried(p));
        ItemStack h = p.inventory.getCurrentItem();
        if (h != null) {
            net.minecraft.nbt.NBTTagCompound t = new net.minecraft.nbt.NBTTagCompound();
            h.writeToNBT(t);
            sb.append(t);
        }
        sb.append(blockAt(p, on));
        if (placeAt != null) sb.append(blockAt(p, placeAt));
        if (crosshair != null) sb.append(blockAt(p, new int[] { crosshair.get("x").getAsInt(), crosshair.get("y").getAsInt(), crosshair.get("z").getAsInt() }));
        sb.append(p.openContainer != p.inventoryContainer)
            .append(p.isUsingItem());
        Map<String, String> d = data(p);
        if (d != null) sb.append(d);
        return sb.toString();
    }

    /** Why the bot found no place to look at the liquid from. */
    private String unseen(EntityPlayerMP p) {
        net.minecraft.world.World w = p.worldObj;
        StringBuilder sb = new StringBuilder("found nowhere to stand within reach from where the liquid at (" + on[0] + "," + on[1] + "," + on[2] + ") can be seen");
        sb.append(" (a liquid is used by looking at it, as a player fills a bucket: a face of it must be in sight with nothing in front");
        if (side >= 0) sb.append(", here its ").append(SIDES[side]).append(" face");
        sb.append(")");
        if (w.blockExists(on[0], on[1] + 1, on[2]) && w.getBlock(on[0], on[1] + 1, on[2]) == w.getBlock(on[0], on[1], on[2])) {
            sb.append("; the block above it is the same liquid, so this one lies under the surface: a block at the surface can be seen");
        }
        return sb.toString();
    }

    /**
     * Whether the server's own protection refused the click on the block (it was then not made, and nothing could
     * come of it); the task fails saying what protects the block.
     */
    private boolean refusedByServer() {
        if (on == null) return false;
        if (liquid && crosshair != null) {
            int cx = crosshair.get("x").getAsInt(), cy = crosshair.get("y").getAsInt(), cz = crosshair.get("z").getAsInt();
            if (bot.serverRefusal(cx, cy, cz) == null) return false;
            fail("denied", bot.refused("right-clicking the block under the crosshair"), bot.refusalDetail(cx, cy, cz));
            return true;
        }
        if (bot.serverRefusal(on[0], on[1], on[2]) == null) return false;
        fail("denied", bot.refused(left ? "left-clicking it" : "right-clicking it"), bot.refusalDetail(on[0], on[1], on[2]));
        return true;
    }

    private static float[] middle(int face) {
        switch (face) {
            case 0:
                return new float[] { 0.5F, 0F, 0.5F };
            case 1:
                return new float[] { 0.5F, 1F, 0.5F };
            case 2:
                return new float[] { 0.5F, 0.5F, 0F };
            case 3:
                return new float[] { 0.5F, 0.5F, 1F };
            case 4:
                return new float[] { 0F, 0.5F, 0.5F };
            default:
                return new float[] { 1F, 0.5F, 0.5F };
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
                if (nav != null && !arrived) {
                    if (++approachTicks > 20 * 60) {
                        fail("stuck", "use approach timed out after 60 seconds of game ticks; no click made. Flight equipment is unchanged and may keep consuming fuel");
                        return;
                    }
                    Navigator.Status st = nav.tick();
                    if (st == Navigator.Status.WORKING) return;
                    if (st == Navigator.Status.FAILED) {
                        if (fallbackGoal != null && "unreachable".equals(nav.failCode)
                            && (p.onGround || p.isInWater() || p.isOnLadder())) {
                            // Nowhere it is seen from: within reach will do, as before; the result says so.
                            faceUnseen = true;
                            nav.go(fallbackGoal, Rules.NATURAL_ONLY, false);
                            fallbackGoal = null;
                            return;
                        }
                        fail(nav.failCode, liquid ? unseen(p) : "cannot get there: " + nav.failMessage);
                        return;
                    }
                    if (!left) {
                        lookPoint = alu.aiplayer.act.Sight.lookPoint(p, on[0], on[1], on[2], side, hit, liquid);
                        if (lookPoint == null && !faceUnseen) {
                            // Off the middle of its cell the look differs from the one planned: to the middle once.
                            if (currentPosition) {
                                fail("out_of_reach", "the requested point is no longer visible from the current position; no click made");
                                return;
                            }
                            if (!recentredForSight) {
                                recentredForSight = true;
                                recentring = 10;
                            }
                            if (recentring-- > 0) {
                                bot.motion.moveToward(p, bot.blockX() + 0.5, bot.blockZ() + 0.5);
                                return;
                            }
                        }
                        if (lookPoint == null && !liquid) faceUnseen = true;
                    }
                    if (liquid) {
                        if (lookPoint == null) {
                            fail("out_of_reach", unseen(p));
                            return;
                        }
                    } else if (!Reach.canReach(p, on[0], on[1], on[2])) {
                        fail("out_of_reach", "the block is out of reach");
                        return;
                    }
                    if (!liquid && lookPoint == null && side >= 0 && !alu.aiplayer.act.Drawers.inFront(p, on[0], on[1], on[2], side)) {
                        fail("out_of_reach", "the bot could not get to where the " + SIDES[side] + " face of that block can be clicked");
                        return;
                    }
                }
                arrived = true;
                if (on != null && !dataTaken) {
                    if (dataWait == 0) dataEarly = data(p);
                    if (++dataWait <= 2) return;
                    dataBefore = data(p);
                    dataTaken = true;
                }
                if (p.openContainer != p.inventoryContainer) bot.conn()
                    .closeWindow();
                before = carried(p);
                if (on != null) blockBefore = blockAt(p, on);
                phase = "using it";
                wasSneaking = p.isSneaking();
                if (sneak) p.setSneaking(true);
                if (item != null) {
                    for (int i = 0; i < Inventories.CARRY_SLOTS && heldBefore == null; i++) {
                        ItemStack s = p.inventory.mainInventory[i];
                        if (s != null && item.matches(s)) heldBefore = Names.displayName(s);
                    }
                }
                if (!click(p)) {
                    if (item == null) fail("inventory_full", "cannot prepare an empty hand: no empty hotbar or backpack slot to move the held stack into");
                    else fail("no_material", "the bot carries no such item");
                    return;
                }
                if (refusedByServer()) return;
                stage = 1;
                wait = 0;
                break;
            }
            case 1: {
                // The further clicks of a held button, until a screen opens.
                if (clicks >= times || p.openContainer != p.inventoryContainer) {
                    stage = 2;
                    wait = 0;
                    return;
                }
                if (++wait < every) return;
                wait = 0;
                click(p);
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

    private Map<String, String> data(EntityPlayerMP p) {
        net.minecraft.world.World w = p.worldObj;
        if (!w.blockExists(on[0], on[1], on[2])) return null;
        net.minecraft.tileentity.TileEntity te = w.getTileEntity(on[0], on[1], on[2]);
        if (te == null) return null;
        try {
            net.minecraft.nbt.NBTTagCompound tag = new net.minecraft.nbt.NBTTagCompound();
            te.writeToNBT(tag);
            return alu.aiplayer.util.Nbt.flatten(tag);
        } catch (Throwable t) {
            return null;
        }
    }

    /** What changed in the clicked block's saved data, leaving out what was already changing by itself. */
    private void dataChanges(EntityPlayerMP p, JsonObject o) {
        if (dataBefore == null) return;
        Map<String, String> now = data(p);
        if (now == null) return;
        java.util.Set<String> keys = new java.util.TreeSet<>(dataBefore.keySet());
        keys.addAll(now.keySet());
        JsonArray changed = new JsonArray();
        int more = 0, moving = 0;
        for (String k : keys) {
            String was = dataBefore.get(k), is = now.get(k);
            if (was == null ? is == null : was.equals(is)) continue;
            String early = dataEarly == null ? null : dataEarly.get(k);
            if (dataEarly != null && !(early == null ? was == null : early.equals(was))) {
                moving++;
                continue;
            }
            if (changed.size() >= 30) {
                more++;
                continue;
            }
            JsonObject c = new JsonObject();
            c.addProperty("key", k);
            if (was != null) c.addProperty("was", was);
            if (is != null) c.addProperty("now", is);
            changed.add(c);
        }
        o.add("dataChanged", changed);
        if (more > 0) o.addProperty("dataChangedMore", more);
        if (moving > 0) o.addProperty("dataMovingLeftOut", moving);
    }

    /** The liquid clicked: which fluid, and whether it is a source (meta 0) or flowing. */
    private JsonObject liquidJson(net.minecraft.world.World w) {
        JsonObject o = new JsonObject();
        net.minecraft.block.Block b = w.getBlock(on[0], on[1], on[2]);
        String was = blockBefore == null ? null : blockBefore;
        net.minecraftforge.fluids.Fluid f = net.minecraftforge.fluids.FluidRegistry.lookupFluidForBlock(b);
        if (f == null && was != null) {
            net.minecraft.block.Block old = Names.block(was.substring(0, was.lastIndexOf('/')));
            if (old != null) f = net.minecraftforge.fluids.FluidRegistry.lookupFluidForBlock(old);
        }
        if (f != null) {
            o.addProperty("fluid", f.getName());
            o.addProperty("name", f.getLocalizedName());
        }
        if (was != null) o.addProperty("source", was.endsWith("/0"));
        return o;
    }

    /**
     * Whether the game knows the item in the hand as a container of that liquid: the filled item its fluid registry
     * gives for it (an empty bucket and water give a water bucket), or the item keeping fluid in itself. Null when
     * the hand was empty or the liquid is no registered fluid.
     */
    private JsonObject fillJson() {
        if (heldAtFirst == null || blockBefore == null) return null;
        net.minecraft.block.Block b = Names.block(blockBefore.substring(0, blockBefore.lastIndexOf('/')));
        net.minecraftforge.fluids.Fluid f = b == null ? null : net.minecraftforge.fluids.FluidRegistry.lookupFluidForBlock(b);
        if (f == null) return null;
        JsonObject o = new JsonObject();
        try {
            ItemStack one = heldAtFirst.copy();
            one.stackSize = 1;
            ItemStack filled = net.minecraftforge.fluids.FluidContainerRegistry
                .fillFluidContainer(new net.minecraftforge.fluids.FluidStack(f, net.minecraftforge.fluids.FluidContainerRegistry.BUCKET_VOLUME), one);
            if (filled != null) {
                JsonObject k = new JsonObject();
                k.addProperty("id", Names.itemId(filled.getItem()));
                k.addProperty("meta", filled.getItemDamage());
                k.addProperty("name", Names.displayName(filled));
                o.add("filledIs", k);
            }
        } catch (Throwable t) {
            // a container the registry cannot answer for
        }
        if (heldAtFirst.getItem() instanceof net.minecraftforge.fluids.IFluidContainerItem) o.addProperty("holdsFluidItself", true);
        // IC2 ItemCell.onItemUse performs its own liquid ray; it has no air-use filling callback.
        // A registry recipe alone does not imply either callback. Keep this native behavior separate.
        if (heldAtFirst.getItemDamage() == 0 && heldAtFirst.getItem().getClass().getName().equals("ic2.core.item.resources.ItemCell")) {
            o.addProperty("worldFill", "block_click");
        }
        if (o.entrySet()
            .isEmpty()) o.addProperty("none", true);
        return o;
    }

    private static String blockAt(EntityPlayerMP p, int[] at) {
        net.minecraft.world.World w = p.worldObj;
        if (!w.blockExists(at[0], at[1], at[2])) return "?";
        return Names.blockId(w.getBlock(at[0], at[1], at[2])) + "/" + w.getBlockMetadata(at[0], at[1], at[2]);
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
        o.addProperty("left", left);
        o.addProperty("clicks", clicks);
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
        o.addProperty("used", heldBefore == null ? "an empty hand" : heldBefore);
        o.addProperty("clicks", clicks);
        if (on != null && clicks > 0) {
            if (liquid && lookPoint != null) {
                // Looked at, not clicked: no click can be aimed at a liquid.
                o.addProperty("lookedAt", SIDES[(int) lookPoint[0]]);
                o.add("liquid", liquidJson(p.worldObj));
                if (crosshair != null) o.add("crosshair", crosshair);
                if (crosshairNone) o.addProperty("crosshairNone", true);
                JsonObject fill = fillJson();
                if (fill != null) o.add("fluidContainer", fill);
            } else {
                o.addProperty("side", SIDES[lookPoint != null && !left ? (int) lookPoint[0] : side >= 0 ? side : Reach.facingSide(p, on[0], on[1], on[2])]);
                if (faceUnseen && !left) o.addProperty("faceUnseen", true);
            }
            // The block clicked, before and after: a block that changed or went away shows here.
            if (blockBefore != null) {
                o.addProperty("blockBefore", blockBefore);
                o.addProperty("blockNow", blockAt(p, on));
            }
            // The cell a block from the hand goes into: with a block in the hand, or whenever it changed.
            if (!left && placeAt != null && placeBefore != null) {
                String there = blockAt(p, placeAt);
                boolean same = placeAt[0] == on[0] && placeAt[1] == on[1] && placeAt[2] == on[2];
                if (heldPlacesBlock || !there.equals(placeBefore)) {
                    JsonObject cell = J.pos(placeAt[0], placeAt[1], placeAt[2]);
                    if (same) cell.addProperty("clicked", true);
                    cell.addProperty("before", placeBefore);
                    cell.addProperty("now", there);
                    o.add("placeCell", cell);
                }
                if (notPlaced != null) o.addProperty("notPlaced", notPlaced);
            }
            dataChanges(p, o);
        }
        if (inAir > 0) {
            o.addProperty("alsoInAir", inAir);
            if (looking != null) o.add("looking", looking);
            if (lookingAtNothing) o.addProperty("lookingAtNothing", true);
        }
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
