package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.IInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.ContainerSession;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Machines;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * Runs a batch through a GregTech processing machine: puts the given items into its input slots, waits while it
 * works, and brings back what comes out. If the machine does not start (no power, no such recipe, a missing
 * circuit or fluid) the inputs are taken out again and the task says so.
 */
public final class ProcessTask extends Task {

    private static final int START_WAIT = 60;

    private final int[] at;
    private final List<ItemFilter> inputs;
    private final int limitTicks;

    private ContainerTrip trip;
    private int stage;
    private int waited;
    private int idle;
    private boolean ran;
    private int put;
    private Map<String, Integer> before;
    private JsonArray outputs = new JsonArray();
    private boolean timedOut;

    public ProcessTask(JsonObject params) {
        super("process", params);
        at = Params.pos(params, "machine");
        inputs = Inventories.filters(J.array(params, "inputs"));
        if (inputs.isEmpty() || inputs.size() > 9) throw new IllegalArgumentException("inputs must list 1 to 9 items");
        for (ItemFilter f : inputs) {
            if (f.count <= 0) throw new IllegalArgumentException("each input needs a count");
        }
        limitTicks = 20 * Math.max(5, Math.min(1800, J.i(params, "wait", 180)));
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (!withinTravel(at[0], at[2])) return;
        phase = "going to the machine";
        trip = new ContainerTrip(bot, at[0], at[1], at[2]);
        final int[] left = new int[inputs.size()];
        for (int i = 0; i < left.length; i++) left[i] = inputs.get(i).count;
        trip.session.deposit(new ContainerSession.DepositPlan() {

            @Override
            public int wanted(ItemStack stack) {
                for (int i = 0; i < left.length; i++) {
                    if (left[i] > 0 && inputs.get(i)
                        .matches(stack)) return Math.min(left[i], stack.stackSize);
                }
                return 0;
            }

            @Override
            public void moved(ItemStack type, int count) {
                for (int i = 0; i < left.length; i++) {
                    if (left[i] > 0 && inputs.get(i)
                        .matches(type)) {
                        left[i] -= count;
                        return;
                    }
                }
            }
        });
    }

    @Override
    public void cleanup() {
        if (trip != null) trip.stop();
    }

    private TileEntity machine() {
        EntityPlayerMP p = bot.player();
        return p.worldObj.blockExists(at[0], at[1], at[2]) ? p.worldObj.getTileEntity(at[0], at[1], at[2]) : null;
    }

    @Override
    public void tick() {
        switch (stage) {
            case 0: { // loading
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                if (st == ContainerTrip.Status.FAILED) {
                    fail(trip.failCode, trip.failMessage);
                    return;
                }
                TileEntity te = machine();
                if (!Machines.isProcessor(te)) {
                    fail("invalid", "that is not a processing machine", J.pos(at[0], at[1], at[2]));
                    return;
                }
                put = trip.session.moved;
                if (put <= 0) {
                    fail(
                        "invalid",
                        "the machine took none of the inputs: they are not in the inventory, or its input slots are occupied",
                        Machines.describe(te));
                    return;
                }
                before = carried();
                phase = "waiting for the machine";
                stage = 1;
                waited = 0;
                break;
            }
            case 1: { // working
                TileEntity te = machine();
                if (!Machines.isProcessor(te)) {
                    fail("invalid", "the machine is gone");
                    return;
                }
                waited++;
                boolean active = Machines.isActive(te);
                if (active) {
                    ran = true;
                    idle = 0;
                } else {
                    idle++;
                }
                if (!ran && waited > START_WAIT) {
                    // It never started. Take the inputs back out rather than leave them sitting there.
                    phase = "taking the inputs back";
                    collect(true);
                    stage = 3;
                } else if ((ran && idle > 15 && inputsUsedUp(te)) || (ran && idle > 100) || waited > limitTicks) {
                    timedOut = waited > limitTicks;
                    phase = "collecting the output";
                    collect(false);
                    stage = 2;
                }
                break;
            }
            case 2: { // unloading
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                if (st == ContainerTrip.Status.FAILED) {
                    outputs = gained();
                    fail(trip.failCode, trip.failMessage);
                    return;
                }
                // What the bot put in and the recipe did not use up (a circuit, a mould, a surplus) comes back
                // out too. Anything else in the input slots was there before and stays.
                trip = new ContainerTrip(bot, at[0], at[1], at[2]);
                List<ItemFilter> own = new ArrayList<>();
                for (ItemFilter f : inputs) own.add(new ItemFilter(f.id, f.meta, -1));
                trip.session.withdraw(own)
                    .fromInputSlots();
                stage = 4;
                break;
            }
            case 4: {
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                outputs = gained();
                if (outputs.size() == 0) fail("invalid", "the machine ran but nothing could be taken out of it");
                else done();
                break;
            }
            default: { // inputs taken back after the machine did not start
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                TileEntity te = machine();
                fail(
                    "invalid",
                    "the machine did not start: it may lack power, a programmed circuit or a fluid, or these inputs"
                        + " are not a recipe it runs. The inputs are back in the inventory.",
                    te == null ? null : Machines.describe(te));
                break;
            }
        }
    }

    private void collect(boolean inputsBack) {
        trip = new ContainerTrip(bot, at[0], at[1], at[2]);
        trip.session.withdrawAll();
        if (inputsBack) trip.session.fromInputSlots();
    }

    private boolean inputsUsedUp(TileEntity te) {
        int[] in = Machines.inputSlots(te);
        if (in == null || !(te instanceof IInventory)) return true;
        IInventory inv = (IInventory) te;
        for (int i = 0; i < in[1]; i++) {
            ItemStack s = inv.getStackInSlot(in[0] + i);
            // What stays behind with a count of zero is a circuit or mould, not something waiting to be used.
            if (s == null || s.stackSize <= 0) continue;
            for (ItemFilter f : inputs) if (f.matches(s)) return false;
        }
        return true;
    }

    private Map<String, Integer> carried() {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (ItemStack s : bot.player().inventory.mainInventory) {
            if (s == null) continue;
            out.merge(Names.itemId(s.getItem()) + "@" + Names.meta(s), s.stackSize, Integer::sum);
        }
        return out;
    }

    /** What the bot carries more of now than when it finished loading the machine. */
    private JsonArray gained() {
        JsonArray out = new JsonArray();
        if (before == null) return out;
        Map<String, Integer> now = carried();
        List<String> seen = new ArrayList<>();
        for (ItemStack s : bot.player().inventory.mainInventory) {
            if (s == null) continue;
            String key = Names.itemId(s.getItem()) + "@" + Names.meta(s);
            if (seen.contains(key)) continue;
            seen.add(key);
            Integer had = before.get(key);
            int more = now.get(key) - (had == null ? 0 : had);
            if (more <= 0) continue;
            JsonObject o = Names.describe(s);
            o.remove("durability");
            o.addProperty("count", more);
            out.add(o);
        }
        return out;
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        o.addProperty("put", put);
        o.add("outputs", outputs);
        if (timedOut) o.addProperty("timedOut", true);
        if (bot != null && bot.online()) o.addProperty("freeSlots", Inventories.freeSlots(bot.player()));
        return o;
    }
}
