package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.nav.NavWorld;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;

/** Breaks a given list of blocks, nearest first. */
public final class DigTask extends AreaTask {

    private final List<int[]> targets = new ArrayList<>();
    private int[] current;

    public DigTask(JsonObject params) {
        super("dig", params);
        JsonArray blocks = J.array(params, "blocks");
        if (blocks == null || blocks.size() == 0) throw new IllegalArgumentException("blocks must list positions");
        if (blocks.size() > 256) throw new IllegalArgumentException("at most 256 blocks per dig task");
        final Set<Long> listed = new HashSet<>();
        for (JsonElement e : blocks) {
            int[] p = Params.pos(e.getAsJsonObject());
            targets.add(p);
            listed.add(key(p[0], p[1], p[2]));
        }
        progressTotal = targets.size();
        rule = new NavWorld.BreakRule() {

            @Override
            public boolean mayBreak(World w, int x, int y, int z, Block block) {
                return listed.contains(key(x, y, z)) || Rules.isNatural(block);
            }
        };
    }

    @Override
    public void start(alu.aiplayer.bot.Bot bot) {
        super.start(bot);
        for (int[] t : targets) if (!withinTravel(t[0], t[2])) return;
    }

    @Override
    public void tick() {
        if (busyWithErrand()) return;
        if (current != null) {
            Act a = digCell(current[0], current[1], current[2]);
            if (a == Act.BUSY || a == Act.FAILED) return;
            if (a == Act.UNREACHABLE) skip(current[0], current[1], current[2], "unreachable");
            progressDone++;
            current = null;
        }
        if (inventoryFull() && !relieveInventory(null)) return;
        if (targets.isEmpty()) {
            done();
            return;
        }
        current = takeNearest(targets, false);
    }
}
