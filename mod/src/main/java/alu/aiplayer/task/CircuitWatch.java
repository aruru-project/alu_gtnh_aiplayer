package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.inventory.IInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;
import net.minecraftforge.common.DimensionManager;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Machines;
import alu.aiplayer.util.J;

/**
 * A programmed circuit a process task with leave set on a machine (a multiblock: on its input bus), to be set back
 * to what it was once that batch is done: the machine is not running a recipe and none of what the bot put in and
 * the recipe uses up is left in its input slots. Every round of a batch put in at once needs the circuit, so it
 * cannot be set back when the task ends. Someone setting it to something else meanwhile is left alone. Kept in the
 * bots' save file, so a restart does not forget it.
 */
public final class CircuitWatch {

    public final String bot;
    public final String task;
    public final int dim;
    /** The machine (a multiblock's controller), whose running a recipe is watched. */
    public final int[] machine;
    /** Where the circuit is: the machine, or the input bus the inputs went into. */
    public final int[] at;
    /** What the task set, and what it was before. */
    public final int set;
    public final int was;
    /** What the bot put in that the recipe uses up: while any of it is in the input slots the batch is not done. */
    private final List<JsonObject> usedUp = new ArrayList<>();

    public CircuitWatch(String bot, String task, int dim, int[] machine, int[] at, int set, int was) {
        this.bot = bot;
        this.task = task;
        this.dim = dim;
        this.machine = machine;
        this.at = at;
        this.set = set;
        this.was = was;
    }

    /** Another kind the batch uses up ({id, meta?}). */
    public void addUsedUp(ItemFilter f) {
        for (JsonObject o : usedUp) {
            if (o.get("id")
                .getAsString()
                .equals(f.id) && J.i(o, "meta", -1) == f.meta) return;
        }
        JsonObject o = new JsonObject();
        o.addProperty("id", f.id);
        if (f.meta >= 0) o.addProperty("meta", f.meta);
        usedUp.add(o);
    }

    public boolean at(String bot, int dim, int[] p) {
        return this.bot.equals(bot) && this.dim == dim && at[0] == p[0] && at[1] == p[1] && at[2] == p[2];
    }

    /**
     * Looks at the machine. Null while the batch goes on (or the place is not loaded); otherwise the watch is over
     * and this is what to tell the brain (machine.circuit): set back, or why not.
     */
    public JsonObject check() {
        World w = DimensionManager.getWorld(dim);
        if (w == null || !w.blockExists(at[0], at[1], at[2]) || !w.blockExists(machine[0], machine[1], machine[2])) return null;
        TileEntity where = w.getTileEntity(at[0], at[1], at[2]);
        int now = where == null ? -1 : Machines.circuit(where);
        if (now < 0) return ended(false, now, "there is no programmed-circuit setting there any more: the machine or bus is gone");
        if (now != set) {
            return ended(
                false,
                now,
                "it was set to " + text(now) + " meanwhile, not by this task, so it is left as it is");
        }
        TileEntity m = w.getTileEntity(machine[0], machine[1], machine[2]);
        if (m != null && Machines.working(m)) return null;
        if (holdsUsedUp(where)) return null;
        if (!Machines.setCircuit(where, was)) return ended(false, now, "setting it back did not take");
        return ended(true, was, null);
    }

    private boolean holdsUsedUp(TileEntity where) {
        int[] in = Machines.inputSlots(where);
        if (in == null || !(where instanceof IInventory)) return false;
        IInventory inv = (IInventory) where;
        List<ItemFilter> filters = new ArrayList<>();
        for (JsonObject o : usedUp) {
            try {
                filters.add(ItemFilter.parse(o));
            } catch (RuntimeException ignored) {
                // An item that no longer exists cannot be in the slots either.
            }
        }
        for (int i = 0; i < in[1]; i++) {
            ItemStack s = inv.getStackInSlot(in[0] + i);
            if (s == null || s.stackSize <= 0) continue;
            for (ItemFilter f : filters) if (f.matches(s)) return true;
        }
        return false;
    }

    static String text(int circuit) {
        return circuit == 0 ? "0 (none)" : String.valueOf(circuit);
    }

    private JsonObject ended(boolean restored, int now, String why) {
        JsonObject o = new JsonObject();
        o.addProperty("bot", bot);
        o.addProperty("task", task);
        o.add("machine", J.pos(machine[0], machine[1], machine[2]));
        if (at[0] != machine[0] || at[1] != machine[1] || at[2] != machine[2]) o.add("bus", J.pos(at[0], at[1], at[2]));
        o.addProperty("dim", dim);
        o.addProperty("set", set);
        o.addProperty("was", was);
        if (now >= 0) o.addProperty("now", now);
        o.addProperty("restored", restored);
        if (why != null) o.addProperty("reason", why);
        return o;
    }

    public JsonObject save() {
        JsonObject o = new JsonObject();
        o.addProperty("bot", bot);
        o.addProperty("task", task);
        o.addProperty("dim", dim);
        o.add("machine", J.pos(machine[0], machine[1], machine[2]));
        o.add("at", J.pos(at[0], at[1], at[2]));
        o.addProperty("set", set);
        o.addProperty("was", was);
        JsonArray kinds = new JsonArray();
        for (JsonObject k : usedUp) kinds.add(k);
        o.add("usedUp", kinds);
        return o;
    }

    public static CircuitWatch load(JsonObject o) {
        CircuitWatch w = new CircuitWatch(
            J.reqStr(o, "bot"),
            J.str(o, "task", ""),
            J.i(o, "dim", 0),
            Params.pos(o, "machine"),
            Params.pos(o, "at"),
            J.i(o, "set", 0),
            J.i(o, "was", 0));
        JsonArray kinds = J.array(o, "usedUp");
        if (kinds != null) for (JsonElement e : kinds) if (e.isJsonObject()) w.usedUp.add(e.getAsJsonObject());
        return w;
    }
}
