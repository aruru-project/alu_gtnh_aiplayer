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
import alu.aiplayer.util.Kinds;
import alu.aiplayer.util.Names;

/**
 * Runs a batch through a GregTech machine: puts the given items in, waits while it works, and brings back what
 * comes out. If the machine does not start (no power, no such recipe, a missing circuit or fluid) the inputs are
 * taken out again and the task says so. What the machine made is counted as it works (the rounds it finishes, by its
 * own record of each recipe), apart from what is brought back: its auto-output, a cover or a pipe may move the
 * products on while it works, and then the task has still done its job and says where they turned up.
 * <p>
 * A single-block machine is loaded and emptied at the machine itself. A multiblock is named by its controller and
 * used the way a player uses one by hand: items into an input bus, cells of fluid into an input hatch, the
 * programmed circuit set on the bus, products out of the output buses.
 */
public final class ProcessTask extends Task {

    private static final int START_WAIT = 60;
    /** A multiblock looks for work about once a second and may first have to check its structure. */
    private static final int START_WAIT_MULTI = 200;
    private static final int DRAIN_WAIT = 60;

    private final int[] at;
    private final List<ItemFilter> inputs;
    private final List<ItemFilter> fluids;
    private final int circuit;
    private final int[] wantedBus;
    private final List<ItemFilter> expect;
    private final int limitTicks;

    private boolean multi;
    /** A machine known only by its screen; whether it is working is told from its contents changing. */
    private boolean plain;
    private long contents;
    private int unchanged;
    private int[] loadAt;
    private int[] hatchAt;
    private final List<int[]> unloadAt = new ArrayList<>();
    /** Chests an output bus hands its contents on to; looked into only for what the caller said to expect. */
    private final List<int[]> passedTo = new ArrayList<>();
    private final JsonArray passedToJson = new JsonArray();
    private int unloadIndex;
    private int oldCircuit = -1;
    private boolean circuitSet;

    private ContainerTrip trip;
    private int stage;
    private int waited;
    private int idle;
    private boolean ran;
    private int put;
    private int poured;
    private int lastPoured;
    private Map<String, Integer> before;
    private JsonArray outputs = new JsonArray();
    private boolean timedOut;

    public ProcessTask(JsonObject params) {
        super("process", params);
        at = Params.pos(params, "machine");
        inputs = Inventories.filters(J.array(params, "inputs"));
        fluids = J.has(params, "fluids") ? Inventories.filters(J.array(params, "fluids")) : new ArrayList<ItemFilter>();
        if (inputs.isEmpty() && fluids.isEmpty() || inputs.size() > 9 || fluids.size() > 4) {
            throw new IllegalArgumentException("inputs must list 1 to 9 items (fluids: up to 4 kinds of filled cells)");
        }
        for (ItemFilter f : inputs) if (f.count <= 0) throw new IllegalArgumentException("each input needs a count");
        for (ItemFilter f : fluids) if (f.count <= 0) throw new IllegalArgumentException("each fluid needs a count");
        circuit = J.has(params, "circuit") ? J.i(params, "circuit", 0) : -1;
        if (circuit > 24) throw new IllegalArgumentException("circuit is a number from 0 (none) to 24");
        wantedBus = J.has(params, "bus") ? Params.pos(params, "bus") : null;
        expect = J.has(params, "expect") ? Inventories.filters(J.array(params, "expect")) : new ArrayList<ItemFilter>();
        limitTicks = 20 * Math.max(5, Math.min(3600, J.i(params, "wait", 180)));
        leave = J.bool(params, "leave", false);
    }

    /**
     * Put the inputs in, see that the machine has started, and go: what a player does with a machine that takes
     * minutes. Nothing is collected and the circuit setting stays as it was set; the products are taken out
     * later, like out of any container.
     */
    private final boolean leave;
    private boolean left;
    private JsonObject leftState;

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (!withinTravel(at[0], at[2])) return;
        TileEntity te = machine();
        if (te == null) {
            fail("unloaded", "that place is not loaded; go closer first", J.pos(at[0], at[1], at[2]));
            return;
        }
        if (!Machines.isRunnable(te)) {
            // Not a kind of machine this mod can read. It can still be used the way a player uses any machine:
            // put things into its screen, wait for what it holds to stop changing, take what it made.
            if (!(te instanceof IInventory)) {
                fail("invalid", "there is nothing at that position that things can be put into", J.pos(at[0], at[1], at[2]));
                return;
            }
            plain = true;
        }
        multi = Machines.isMultiblock(te);
        if (!multi) {
            if (!fluids.isEmpty()) {
                fail("invalid", "fluids from cells are only poured into a multiblock's input hatch; this is a single-block machine");
                return;
            }
            loadAt = at;
            unloadAt.add(at);
        } else {
            String why = Machines.idleReason(te);
            List<TileEntity> buses = Machines.ports(te, "input bus");
            if (buses.isEmpty() || Machines.ports(te, "output bus")
                .isEmpty() && !inputs.isEmpty()) {
                fail(
                    "invalid",
                    "the multiblock has no usable " + (buses.isEmpty() ? "input" : "output")
                        + " bus"
                        + (why == null ? "" : ": " + why),
                    Machines.describe(te));
                return;
            }
            TileEntity bus = null;
            for (TileEntity b : buses) {
                if (wantedBus != null) {
                    if (b.xCoord == wantedBus[0] && b.yCoord == wantedBus[1] && b.zCoord == wantedBus[2]) bus = b;
                } else if (bus == null || emptySlots(b) > emptySlots(bus)) {
                    bus = b;
                }
            }
            if (bus == null) {
                fail("invalid", "bus is not one of this machine's input buses", Machines.describe(te));
                return;
            }
            loadAt = new int[] { bus.xCoord, bus.yCoord, bus.zCoord };
            for (TileEntity b : Machines.ports(te, "output bus")) {
                unloadAt.add(new int[] { b.xCoord, b.yCoord, b.zCoord });
                for (TileEntity next : alu.aiplayer.world.WorldQueries.passesTo(b.getWorldObj(), b)) {
                    passedTo.add(new int[] { next.xCoord, next.yCoord, next.zCoord });
                    JsonObject c = J.pos(next.xCoord, next.yCoord, next.zCoord);
                    c.addProperty(
                        "name",
                        alu.aiplayer.world.WorldQueries.blockName(next.getBlockType(), next.getBlockMetadata()));
                    passedToJson.add(c);
                }
            }
            if (!fluids.isEmpty()) {
                List<TileEntity> hatches = Machines.ports(te, "input hatch");
                if (hatches.isEmpty()) {
                    fail("invalid", "the multiblock has no input hatch to pour fluids into", Machines.describe(te));
                    return;
                }
                hatchAt = new int[] { hatches.get(0).xCoord, hatches.get(0).yCoord, hatches.get(0).zCoord };
            }
        }
        if (inputs.isEmpty()) {
            beginPouring();
        } else {
            phase = multi ? "going to the input bus" : "going to the machine";
            trip = new ContainerTrip(bot, loadAt[0], loadAt[1], loadAt[2]);
            trip.session.deposit(plan(inputs));
            if (circuit >= 0) {
                // Standing at it, before anything goes in: the moment a player clicks the circuit. Set afterwards,
                // the machine could start on the first inputs with the circuit it had (a bender set to 1 made foil).
                trip.beforeSession(() -> {
                    TileEntity where = tile(loadAt);
                    oldCircuit = where == null ? -1 : Machines.circuit(where);
                    if (oldCircuit < 0 || !Machines.setCircuit(where, circuit)) return false;
                    circuitSet = true;
                    return true;
                }, "this " + (multi ? "input bus" : "machine") + " has no programmed-circuit setting; nothing was put in");
            }
        }
    }

    private static int emptySlots(TileEntity bus) {
        int[] range = Machines.inputSlots(bus);
        if (range == null || !(bus instanceof IInventory)) return 0;
        int n = 0;
        for (int i = 0; i < range[1]; i++) if (((IInventory) bus).getStackInSlot(range[0] + i) == null) n++;
        return n;
    }

    private static ContainerSession.DepositPlan plan(final List<ItemFilter> wanted) {
        final int[] left = new int[wanted.size()];
        for (int i = 0; i < left.length; i++) left[i] = wanted.get(i).count;
        return new ContainerSession.DepositPlan() {

            @Override
            public int wanted(ItemStack stack) {
                for (int i = 0; i < left.length; i++) {
                    if (left[i] > 0 && wanted.get(i)
                        .matches(stack)) return Math.min(left[i], stack.stackSize);
                }
                return 0;
            }

            @Override
            public void moved(ItemStack type, int count) {
                for (int i = 0; i < left.length; i++) {
                    if (left[i] > 0 && wanted.get(i)
                        .matches(type)) {
                        left[i] -= count;
                        return;
                    }
                }
            }
        };
    }

    @Override
    public void cleanup() {
        if (trip != null) trip.stop();
    }

    private TileEntity tile(int[] p) {
        EntityPlayerMP pl = bot.player();
        return pl.worldObj.blockExists(p[0], p[1], p[2]) ? pl.worldObj.getTileEntity(p[0], p[1], p[2]) : null;
    }

    private TileEntity machine() {
        return tile(at);
    }

    private void beginPouring() {
        phase = "pouring fluids into the input hatch";
        trip = new ContainerTrip(bot, hatchAt[0], hatchAt[1], hatchAt[2]);
        // A hatch takes one cell at a time and empties it over the next moments; one cell per visit of its slot.
        trip.session.deposit(plan(fluids));
        stage = 5;
    }

    /** What the machine's tanks (a multiblock's output hatches) hold, to tell afterwards whether that changed. */
    private com.google.gson.JsonElement fluidState() {
        try {
            TileEntity m = machine();
            if (m == null) return new JsonArray();
            if (multi) {
                JsonObject d = Machines.describe(m);
                return d != null && d.has("outputHatches") ? d.get("outputHatches") : new JsonArray();
            }
            return Machines.tanks(m);
        } catch (Throwable t) {
            return new JsonArray();
        }
    }

    private String fluidsBefore;
    private com.google.gson.JsonElement fluidsAfter;

    private void beginWaiting() {
        fluidsBefore = fluidState().toString();
        // The slots right after loading: a change from this means the machine took the inputs.
        TileEntity te = machine();
        if (!plain && te instanceof IInventory) contents = fingerprint((IInventory) te);
        before = carried();
        lookAround();
        phase = "waiting for the machine";
        stage = 1;
        waited = 0;
    }

    // ---- what the machine does while it is watched, and where its products go ------------------------------

    /** Recipe runs the machine was seen to finish while the task watched it. */
    private int rounds;
    /** What those runs made, by the machine's own record of each recipe as it started it. */
    private final Kinds made = new Kinds();
    private int lastProgress, lastMax;
    private Object lastToken;
    private JsonArray lastMaking;

    /**
     * Called every tick while the machine works: a run has ended when the recipe it was on is gone, its progress went
     * back, or it holds the products of a new recipe. A machine switched off or shut down (a multiblock out of power)
     * loses its recipe without finishing it; that is no run.
     */
    private void watchRounds(TileEntity te) {
        int max = Machines.maxProgress(te), progress = Machines.progress(te);
        Object token = Machines.recipeToken(te);
        boolean ended = lastMax > 0 && Machines.allowedToWork(te)
            && (max == 0 || (progress >= 0 && progress < lastProgress) || (token != null && lastToken != null && token != lastToken));
        if (ended) {
            rounds++;
            if (lastMaking != null) for (com.google.gson.JsonElement e : lastMaking) made.add(e.getAsJsonObject());
        }
        if (max <= 0) lastMaking = null;
        else if (lastMaking == null || token != lastToken) lastMaking = Machines.making(te);
        lastMax = max;
        lastProgress = progress;
        lastToken = token;
    }

    /**
     * The containers around the machine (around a multiblock's output buses): where its products land when its
     * auto-output, a cover or a pipe moves them on. Each {x, y, z, side, fromX, fromY, fromZ}, with what it held
     * once the machine was loaded.
     */
    private final List<int[]> around = new ArrayList<>();
    private final List<Map<String, JsonObject>> aroundBefore = new ArrayList<>();
    /** Products found in those containers at the end: [{x, y, z, name, side?, bus?, items}]. */
    private JsonArray elsewhere = new JsonArray();
    /** It made things and none could be taken out: they were moved on while it worked. */
    private boolean sentAway;

    private void lookAround() {
        around.clear();
        aroundBefore.clear();
        net.minecraft.world.World w = bot.player().worldObj;
        java.util.Set<String> skip = new java.util.HashSet<>();
        skip.add(at[0] + "," + at[1] + "," + at[2]);
        for (int[] p : unloadAt) skip.add(p[0] + "," + p[1] + "," + p[2]);
        for (int[] from : multi ? unloadAt : java.util.Collections.singletonList(at)) {
            TileEntity source = tile(from);
            if (source == null) continue;
            for (int[] p : alu.aiplayer.world.WorldQueries.around(w, source)) {
                if (!skip.add(p[0] + "," + p[1] + "," + p[2])) continue;
                around.add(new int[] { p[0], p[1], p[2], p[3], from[0], from[1], from[2] });
                aroundBefore.add(alu.aiplayer.world.WorldQueries.holds(w, w.getTileEntity(p[0], p[1], p[2])));
            }
        }
    }

    /**
     * What turned up in the containers around the machine while it ran: the kinds it made (for a machine whose
     * recipes cannot be read, any kind that is not one of the inputs), by how many more of each there are now.
     */
    private JsonArray foundAround() {
        JsonArray out = new JsonArray();
        net.minecraft.world.World w = bot.player().worldObj;
        java.util.Set<String> kinds = new java.util.HashSet<>(made.keys());
        if (making != null) for (com.google.gson.JsonElement e : making) kinds.add(Kinds.key(e.getAsJsonObject()));
        for (int i = 0; i < around.size(); i++) {
            int[] p = around.get(i);
            TileEntity t = w.blockExists(p[0], p[1], p[2]) ? w.getTileEntity(p[0], p[1], p[2]) : null;
            if (t == null) continue;
            Map<String, JsonObject> was = aroundBefore.get(i);
            JsonArray items = new JsonArray();
            for (Map.Entry<String, JsonObject> e : alu.aiplayer.world.WorldQueries.holds(w, t)
                .entrySet()) {
                if (plain ? isInput(e.getKey()) : !kinds.contains(e.getKey())) continue;
                JsonObject had = was.get(e.getKey());
                int more = e.getValue()
                    .get("count")
                    .getAsInt()
                    - (had == null ? 0
                        : had.get("count")
                            .getAsInt());
                if (more <= 0) continue;
                JsonObject item = new JsonObject();
                for (Map.Entry<String, com.google.gson.JsonElement> f : e.getValue()
                    .entrySet()) item.add(f.getKey(), f.getValue());
                item.addProperty("count", more);
                items.add(item);
            }
            if (items.size() == 0) continue;
            JsonObject c = J.pos(p[0], p[1], p[2]);
            String name = Machines.name(t);
            c.addProperty(
                "name",
                name != null ? name : alu.aiplayer.world.WorldQueries.blockName(t.getBlockType(), t.getBlockMetadata()));
            if (p[3] >= 0) c.addProperty("side", Machines.SIDES[p[3]]);
            if (multi) c.add("bus", J.pos(p[4], p[5], p[6]));
            c.add("items", items);
            out.add(c);
        }
        return out;
    }

    private boolean isInput(String key) {
        for (ItemFilter f : inputs) if (f.meta < 0 ? key.startsWith(f.id + "@") : key.equals(f.id + "@" + f.meta)) return true;
        return false;
    }

    @Override
    public void tick() {
        switch (stage) {
            case 0: { // loading
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                if (st == ContainerTrip.Status.FAILED) {
                    restoreCircuit();
                    fail(trip.failCode, trip.failMessage);
                    return;
                }
                TileEntity te = machine();
                if (!(te instanceof IInventory)) {
                    fail("invalid", "the machine is gone", J.pos(at[0], at[1], at[2]));
                    return;
                }
                put = trip.session.moved;
                if (put <= 0) {
                    restoreCircuit();
                    fail(
                        "invalid",
                        "none of the inputs went in: they are not in the inventory, or the input "
                            + (multi ? "bus is full" : "slots are occupied"),
                        Machines.describe(te));
                    return;
                }
                if (hatchAt != null) beginPouring();
                else beginWaiting();
                break;
            }
            case 5: { // cells into the hatch
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                if (st == ContainerTrip.Status.FAILED) {
                    fail(trip.failCode, trip.failMessage);
                    return;
                }
                lastPoured = trip.session.moved;
                poured += lastPoured;
                if (poured == 0) {
                    phase = "taking the inputs back";
                    notStarted = "no cell went into the input hatch: there is none in the inventory, or the hatch's slot is occupied";
                    if (inputs.isEmpty()) trip = null;
                    else collect(loadAt, true);
                    stage = 3;
                    return;
                }
                waited = 0;
                stage = 6;
                break;
            }
            case 6: { // the hatch empties the cells one a tick, as long as it has room for the fluid
                if (++waited < Math.max(DRAIN_WAIT, 4 * lastPoured) && !hatchDrained()) return;
                collect(hatchAt, false);
                stage = 7;
                break;
            }
            case 7: { // the empty cells are back; now any full ones the hatch had no room for
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                collect(hatchAt, true);
                stage = 8;
                break;
            }
            case 8: {
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                // Full cells that came back were not poured after all.
                poured -= trip.session.moved;
                beginWaiting();
                break;
            }
            case 1: { // working
                TileEntity te = machine();
                if (!(te instanceof IInventory)) {
                    fail("invalid", "the machine is gone");
                    return;
                }
                waited++;
                boolean active;
                if (plain) {
                    long now = fingerprint((IInventory) te);
                    if (waited == 1) contents = now;
                    if (now != contents) {
                        contents = now;
                        unchanged = 0;
                        ran = true;
                    } else {
                        unchanged++;
                    }
                    // Still "working" for a while after the last change: a furnace takes ten seconds an item.
                    active = ran && unchanged < 240;
                } else {
                    active = Machines.isActive(te);
                    watchRounds(te);
                    // What it set out to make, read while it runs a recipe: if something else got into the machine (a
                    // pipe feeding it, a circuit it still had), this says so.
                    if (Machines.working(te)) {
                        sawWorking = true;
                        if (making == null || making.size() == 0) making = Machines.making(te);
                    }
                }
                if (active) {
                    ran = true;
                    idle = 0;
                } else {
                    idle++;
                }
                // Left to run: the active flag lingers a moment after a recipe ends, so it counts only once a recipe
                // is seen running, or the inputs were taken (a recipe short enough to start and end between two looks).
                boolean started = plain || sawWorking || (ran && (fingerprint((IInventory) te) != contents || inputsUsedUp()));
                if (leave && started) {
                    // It runs (a machine this mod cannot read is taken at its word once the things are in).
                    left = true;
                    leftState = plain ? null : Machines.describe(te);
                    circuitSet = false; // the setting stays: the machine needs it for the rounds still to come
                    done();
                    return;
                }
                if (!ran && waited > (multi || plain ? START_WAIT_MULTI : START_WAIT)) {
                    // It never started. Take the inputs back out rather than leave them sitting there.
                    phase = "taking the inputs back";
                    notStarted = multi ? Machines.idleReason(te) : null;
                    if (inputs.isEmpty()) {
                        stage = 3;
                        trip = null;
                    } else {
                        collect(loadAt, true);
                        stage = 3;
                    }
                } else if ((ran && idle > (multi ? 40 : 15) && inputsUsedUp()) || (ran && idle > 100) || waited > limitTicks) {
                    timedOut = waited > limitTicks;
                    phase = "collecting the output";
                    unloadIndex = 0;
                    collect(unloadAt.get(0), false);
                    stage = 2;
                }
                break;
            }
            case 2: { // unloading, one output place after another
                ContainerTrip.Status st = trip.tick();
                if (st == ContainerTrip.Status.WORKING) return;
                if (st == ContainerTrip.Status.FAILED && unloadIndex + 1 >= unloadAt.size() + passedTo.size()) {
                    outputs = gained();
                    restoreCircuit();
                    fail(trip.failCode, trip.failMessage);
                    return;
                }
                if (++unloadIndex < unloadAt.size()) {
                    collect(unloadAt.get(unloadIndex), false);
                    return;
                }
                int beyond = unloadIndex - unloadAt.size();
                if (beyond < passedTo.size() && !expect.isEmpty()) {
                    List<ItemFilter> still = stillExpected();
                    if (!still.isEmpty()) {
                        int[] where = passedTo.get(beyond);
                        phase = "looking where the output bus passes things on";
                        trip = new ContainerTrip(bot, where[0], where[1], where[2]);
                        trip.session.withdraw(still);
                        return;
                    }
                }
                if (inputs.isEmpty()) {
                    finish();
                    return;
                }
                // What the bot put in and the recipe did not use up (a mould, a surplus) comes back out too.
                // Anything else in there was there before and stays.
                trip = new ContainerTrip(bot, loadAt[0], loadAt[1], loadAt[2]);
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
                finish();
                break;
            }
            default: { // inputs taken back after the machine did not start
                if (trip != null) {
                    ContainerTrip.Status st = trip.tick();
                    if (st == ContainerTrip.Status.WORKING) return;
                }
                restoreCircuit();
                TileEntity te = machine();
                fail(
                    "invalid",
                    "the machine did not start"
                        + (notStarted != null ? ": " + notStarted + "."
                            : ": it may lack power, a programmed circuit or a fluid, or these inputs are not a recipe it runs.")
                        + (inputs.isEmpty() ? "" : " The inputs are back in the inventory."),
                    te == null || plain ? null : Machines.describe(te));
                break;
            }
        }
    }

    private String notStarted;
    private boolean passedOn;
    /** What the machine set out to make when it was first seen working. */
    private JsonArray making;
    /** Whether it was seen running a recipe (not just with its active flag up). */
    private boolean sawWorking;

    /** What the caller expects to get and the bot has not yet gained since loading. */
    private List<ItemFilter> stillExpected() {
        List<ItemFilter> out = new ArrayList<>();
        Map<String, Integer> now = carried();
        for (ItemFilter f : expect) {
            int gainedSoFar = 0;
            for (ItemStack s : bot.player().inventory.mainInventory) {
                if (s == null || !f.matches(s)) continue;
                String key = Names.itemId(s.getItem()) + "@" + Names.meta(s);
                Integer had = before == null ? null : before.get(key);
                gainedSoFar = Math.max(gainedSoFar, now.get(key) - (had == null ? 0 : had));
            }
            int want = f.count <= 0 ? 64 : f.count - gainedSoFar;
            if (want > 0) out.add(new ItemFilter(f.id, f.meta, want));
        }
        return out;
    }

    private void finish() {
        restoreCircuit();
        outputs = gained();
        elsewhere = foundAround();
        if (outputs.size() == 0 && multi && passedTo.size() > 0) {
            // It ran, and the output bus is empty because it does not keep things. That is how this machine is
            // set up, not a failure; the products are for whoever asked to go and find.
            passedOn = true;
            done();
        } else if (outputs.size() == 0 && fluidsBefore != null && !fluidState().toString()
            .equals(fluidsBefore)) {
                // Nothing came out as an item, and what its tanks hold has changed: it ran, and what it made is
                // a fluid. That stays where it is; the result says what is there now.
                fluidsAfter = fluidState();
                done();
            } else if (outputs.size() == 0 && (rounds > 0 || elsewhere.size() > 0)) {
                // It finished recipes, or things it makes turned up next to it, and nothing was left in it to take:
                // its auto-output, a cover or a pipe moved them on while it worked. Made, not failed.
                sentAway = true;
                done();
            } else if (outputs.size() == 0 && timedOut && sawWorking) {
                // Still on its first round when the wait ran out: not failed either, just not done yet.
                done();
            } else if (outputs.size() == 0) {
                fail(
                    "invalid",
                    "the machine ran but nothing could be taken out of it"
                        + (plain ? ", and nothing it might have made turned up next to it" : ", and it was not seen to finish a recipe")
                        + (multi ? "; its products may be fluids, which stay in the output hatch" : ""),
                    plain ? null : Machines.describe(machine()));
            } else {
                done();
            }
    }

    /** Leaves the circuit setting the way it was found; someone else may rely on it. */
    private void restoreCircuit() {
        if (!circuitSet) return;
        circuitSet = false;
        TileEntity where = tile(loadAt);
        if (where != null && oldCircuit >= 0) Machines.setCircuit(where, oldCircuit);
    }

    /** A number that changes whenever anything in the machine's slots does. */
    private static long fingerprint(IInventory inv) {
        long h = 17;
        try {
            for (int i = 0; i < inv.getSizeInventory(); i++) {
                ItemStack st = inv.getStackInSlot(i);
                h = h * 31 + (st == null ? 0
                    : (long) net.minecraft.item.Item.getIdFromItem(st.getItem()) * 65536L + st.getItemDamage() * 131L + st.stackSize);
            }
        } catch (Throwable ignored) {}
        return h;
    }

    private boolean hatchDrained() {
        TileEntity te = tile(hatchAt);
        int[] in = Machines.inputSlots(te);
        return in == null || !(te instanceof IInventory) || ((IInventory) te).getStackInSlot(in[0]) == null;
    }

    private void collect(int[] where, boolean inputsBack) {
        trip = new ContainerTrip(bot, where[0], where[1], where[2]);
        trip.session.withdrawAll();
        if (inputsBack) trip.session.fromInputSlots();
    }

    private boolean inputsUsedUp() {
        TileEntity te = tile(loadAt);
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
        if (poured > 0) o.addProperty("cellsPoured", poured);
        if (left) {
            o.addProperty("left", true);
            o.addProperty(
                "note",
                plain
                    ? "the things are in and the task ended without waiting; whether this machine started cannot be"
                        + " read. What it makes stays in it until it is taken out"
                    : "the machine has started and the task ended without waiting for it. What it makes stays in"
                        + " it until it is taken out (withdraw with the machine as the container); what was put in"
                        + " and is not used up, such as a mould, stays in it too");
            if (leftState != null) o.add("machine", leftState);
            if (making != null && making.size() > 0) o.add("making", making);
            if (circuit >= 0) {
                JsonObject c = new JsonObject();
                c.addProperty("now", circuit);
                c.addProperty("was", oldCircuit);
                o.add("circuit", c);
            }
            if (bot != null && bot.online()) o.addProperty("freeSlots", Inventories.freeSlots(bot.player()));
            return o;
        }
        o.add("outputs", outputs);
        if (making != null && making.size() > 0) o.add("making", making);
        if (rounds > 0) o.addProperty("rounds", rounds);
        if (!made.isEmpty()) o.add("made", made.toJson());
        if (elsewhere.size() > 0) o.add("elsewhere", elsewhere);
        if (sentAway || elsewhere.size() > 0) {
            // How things leave this machine by themselves: its own auto-output, and what is plumbed into it.
            TileEntity te = machine();
            JsonObject auto = te == null ? null : Machines.autoOutput(te);
            if (auto != null) o.add("autoOutput", auto);
            JsonArray attached = te == null ? new JsonArray() : alu.aiplayer.world.WorldQueries.attached(te.getWorldObj(), te);
            if (attached.size() > 0) o.add("attached", attached);
        }
        if (sentAway && plain) {
            o.addProperty(
                "note",
                "nothing could be taken out of the machine, and while it ran, things that are not among the inputs turned"
                    + " up in the containers around it (elsewhere). Its recipes cannot be read, so that they came from it"
                    + " is likely, not certain");
        } else if (sentAway) {
            o.addProperty(
                "note",
                "the machine ran and made things, but none were left in it to take out: something moved them on while it"
                    + " worked (its auto-output, a cover or a pipe). elsewhere lists the containers around it that gained"
                    + " them; what is not there went further than can be seen from the machine");
        } else if (timedOut && outputs.size() == 0 && rounds == 0) {
            o.addProperty(
                "note",
                "the wait ran out while the machine was still on its first recipe; what it finishes stays in it");
        }
        if (passedOn) {
            o.addProperty(
                "note",
                "the machine ran, but its output bus passes what it gets on to other containers, so the products"
                    + " are not in the inventory; look for them in passedTo (give expect to have them fetched)");
        }
        if (passedToJson.size() > 0 && (passedOn || outputs.size() == 0)) o.add("passedTo", passedToJson);
        if (fluidsAfter != null) {
            o.addProperty(
                "note",
                "the machine ran and gave no item: what it made is a fluid, which stays in "
                    + (multi ? "its output hatches" : "its tank")
                    + " (fluids shows what is there now)");
            o.add("fluids", fluidsAfter);
        }
        if (timedOut) o.addProperty("timedOut", true);
        if (bot != null && bot.online()) o.addProperty("freeSlots", Inventories.freeSlots(bot.player()));
        return o;
    }
}
