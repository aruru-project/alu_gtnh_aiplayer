package alu.aiplayer.act;

import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.J;

/** Read-only NEI prediction using the installed GT calculation, never a reimplemented overclock formula. */
public final class MachineOverclock {
    private MachineOverclock() {}

    public static JsonObject calculate(World world, JsonObject p) {
        JsonObject out = new JsonObject();
        int eut = J.i(p, "eut", 0), ticks = J.i(p, "ticks", 0);
        if (eut <= 0 || ticks <= 0) throw RpcException.badRequest("positive base eut and ticks are required");
        if (J.has(p, "machine") == J.has(p, "tier")) throw RpcException.badRequest("give machine or tier, not both");
        out.addProperty("baseEut", eut);
        out.addProperty("baseTicks", ticks);
        try {
            Class<?> standard = Class.forName("gregtech.api.objects.overclockdescriber.EUOverclockDescriber");
            Object describer;
            int machineTier;
            int amperage;
            if (J.has(p, "machine")) {
                JsonObject pos = p.getAsJsonObject("machine");
                int x = J.reqCoord(pos, "x"), y = J.reqHeight(pos, "y"), z = J.reqCoord(pos, "z");
                TileEntity te = world.blockExists(x, y, z) ? world.getTileEntity(x, y, z) : null;
                JsonObject state = te == null ? null : Machines.describe(te);
                if (state == null || Machines.isMultiblock(te)) {
                    out.addProperty("unavailable", "not a readable GT basic electric machine; multiblock heat, parallel, amperage, speed/energy modifiers and overclock mode are unknown to this query");
                    return out;
                }
                out.add("machine", state);
                if (!J.str(state, "recipeKey", "").equals(J.str(p, "recipeKey", "?"))) {
                    out.addProperty("unavailable", "this machine does not run the requested recipe map");
                    return out;
                }
                Object m = te.getClass().getMethod("getMetaTileEntity").invoke(te);
                describer = m.getClass().getMethod("getOverclockDescriber").invoke(m);
                // Custom describers may read special recipe metadata. Never supply them a fabricated recipe.
                if (describer.getClass() != standard) {
                    out.addProperty("unavailable", "machine-specific describer " + describer.getClass().getName() + " needs recipe metadata or machine modifiers not supplied by this base-value query");
                    return out;
                }
                machineTier = m.getClass().getField("mTier").getByte(m);
                amperage = m.getClass().getField("mAmperage").getInt(m);
                out.addProperty("scope", "NEI prediction for this machine's standard electric describer; not a guarantee of power, ingredients, output space or uninterrupted operation");
            } else {
                String[] tiers = { "ULV", "LV", "MV", "HV", "EV", "IV", "LuV", "ZPM", "UV", "UHV", "UEV", "UIV", "UMV", "UXV" };
                machineTier = -1;
                for (int i = 0; i < tiers.length; i++) if (tiers[i].equalsIgnoreCase(J.str(p, "tier", ""))) machineTier = i;
                if (machineTier < 0) throw RpcException.badRequest("unknown GT voltage tier");
                amperage = 1;
                describer = standard.getConstructor(byte.class, int.class).newInstance((byte) machineTier, amperage);
                out.addProperty("scope", "standard electric single-block NEI model at " + tiers[machineTier] + ", 1 A; not arbitrary machines (heat, parallel, amperage and custom modifiers unspecified)");
            }
            long[] voltages = (long[]) Class.forName("gregtech.api.enums.GTValues").getField("V").get(null);
            if (eut > voltages[machineTier] * amperage) {
                out.addProperty("unavailable", "base recipe EU/t exceeds this model's power");
                return out;
            }
            Class<?> calculator = Class.forName("gregtech.api.util.OverclockCalculator");
            Object calc = calculator.getConstructor().newInstance();
            calculator.getMethod("setRecipeEUt", long.class).invoke(calc, (long) eut);
            calculator.getMethod("setDuration", int.class).invoke(calc, ticks);
            // Exact standard class only reads tier/amperage; GTRecipe is unused in this implementation.
            calc = standard.getMethod("createCalculator", calculator, Class.forName("gregtech.api.util.GTRecipe")).invoke(describer, calc, null);
            calculator.getMethod("calculate").invoke(calc);
            out.addProperty("eut", (Number) calculator.getMethod("getConsumption").invoke(calc));
            out.addProperty("ticks", (Number) calculator.getMethod("getDuration").invoke(calc));
            out.addProperty("overclocks", (Number) calculator.getMethod("getPerformedOverclocks").invoke(calc));
            out.addProperty("source", "installed GregTech EUOverclockDescriber.createCalculator / OverclockCalculator (NEI path)");
        } catch (RpcException e) {
            throw e;
        } catch (Throwable t) {
            out.addProperty("unavailable", "installed GT calculation unavailable: " + (t.getCause() == null ? t : t.getCause()).getClass().getSimpleName());
        }
        return out;
    }
}
