package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.util.J;

/** Places a given list of blocks, lowest first, each from the bot's inventory. */
public final class PlaceTask extends AreaTask {

    private final List<int[]> targets = new ArrayList<>();
    private final List<ItemFilter> items = new ArrayList<>();
    private List<int[]> deferred = new ArrayList<>();
    private boolean progressSinceDeferral;
    private int[] current;

    public PlaceTask(JsonObject params) {
        super("place", params);
        JsonArray blocks = J.array(params, "blocks");
        if (blocks == null || blocks.size() == 0) throw new IllegalArgumentException("blocks must list positions");
        if (blocks.size() > 256) throw new IllegalArgumentException("at most 256 blocks per place task");
        for (JsonElement e : blocks) {
            JsonObject o = e.getAsJsonObject();
            int[] p = Params.pos(o);
            // The fourth number is the index of the item this cell gets.
            targets.add(new int[] { p[0], p[1], p[2], items.size() });
            items.add(new ItemFilter(J.reqStr(o, "item"), J.i(o, "meta", -1), -1));
        }
        progressTotal = targets.size();
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
            ItemFilter item = items.get(current[3]);
            Act a = placeCell(current[0], current[1], current[2], item);
            if (a == Act.BUSY || a == Act.FAILED) return;
            if (a == Act.NEED_MATERIAL) {
                JsonObject detail = new JsonObject();
                detail.add("item", item.toJson());
                detail.addProperty("missing", 1 + countSame(current[3]));
                List<ItemFilter> want = new ArrayList<>();
                want.add(new ItemFilter(item.id, item.meta, 1 + countSame(current[3])));
                startSupply(want, "the bot has no " + item.id, detail);
                return;
            }
            if (a == Act.UNREACHABLE) skip(current[0], current[1], current[2], "unreachable");
            if (a == Act.OK) progressSinceDeferral = true;
            else if (!gaveUp.contains(key(current[0], current[1], current[2]))) deferred.add(current);
            progressDone = placed;
            current = null;
        }
        if (targets.isEmpty()) {
            if (!deferred.isEmpty() && progressSinceDeferral) {
                targets.addAll(deferred);
                deferred = new ArrayList<>();
                progressSinceDeferral = false;
            } else {
                for (int[] d : deferred) skip(d[0], d[1], d[2], "nothing to place against");
                done();
                return;
            }
        }
        current = takeNearest(targets, true);
    }

    private int countSame(int itemIndex) {
        ItemFilter f = items.get(itemIndex);
        int n = 0;
        for (int[] t : targets) {
            ItemFilter o = items.get(t[3]);
            if (o.item == f.item && o.meta == f.meta) n++;
        }
        return n;
    }
}
