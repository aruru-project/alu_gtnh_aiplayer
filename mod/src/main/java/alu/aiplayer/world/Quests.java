package alu.aiplayer.world;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTBase;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.nbt.NBTTagList;
import net.minecraft.server.MinecraftServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.Names;
import betterquesting.api.questing.IQuest;
import betterquesting.api.questing.IQuestLine;
import betterquesting.api.questing.rewards.IReward;
import betterquesting.api.questing.tasks.ITask;
import betterquesting.api2.storage.DBEntry;
import betterquesting.api2.utils.QuestTranslation;
import betterquesting.questing.QuestDatabase;
import betterquesting.questing.QuestLineDatabase;
import betterquesting.storage.NameCache;
import cpw.mods.fml.common.Loader;

/**
 * The quest book (BetterQuesting), read on the server: its chapters, the quests in them with what each asks for
 * and gives, and how far a player has got. Nothing here changes anyone's progress.
 * <p>
 * Only {@link #present()} may be called without knowing the mod is installed; every other method touches its
 * classes.
 */
public final class Quests {

    private Quests() {}

    public static boolean present() {
        return Loader.isModLoaded("betterquesting");
    }

    private static String plain(String s) {
        if (s == null) return "";
        // Colour and style codes mean nothing outside the game.
        return s.replaceAll("\u00a7.", "")
            .replace("\r", "")
            .trim();
    }

    private static String name(UUID id, IQuest q) {
        try {
            return plain(QuestTranslation.translateQuestName(id, q));
        } catch (Throwable t) {
            return id.toString();
        }
    }

    private static String description(UUID id, IQuest q) {
        try {
            return plain(QuestTranslation.translateQuestDescription(id, q));
        } catch (Throwable t) {
            return "";
        }
    }

    /** The player whose progress is asked about: someone online, or anyone the quest book has seen. */
    public static UUID player(String name) {
        if (name == null || name.isEmpty()) return null;
        EntityPlayerMP online = MinecraftServer.getServer()
            .getConfigurationManager()
            .func_152612_a(name);
        if (online != null) return online.getUniqueID();
        UUID known = NameCache.INSTANCE.getUUID(name);
        if (known == null) throw RpcException.notFound("the quest book knows no player named " + name);
        return known;
    }

    private static String state(IQuest q, UUID who) {
        if (who == null) return null;
        if (q.isComplete(who)) return q.hasClaimed(who) ? "complete" : "complete, reward unclaimed";
        return q.isUnlocked(who) ? "available" : "locked";
    }

    /**
     * Everything one player has finished, as ids only. The book itself is the same for everybody and whoever asks
     * can keep a copy; who has done what lives in the save and changes while people play.
     */
    public static JsonObject progress(String name) {
        JsonObject out = new JsonObject();
        out.addProperty("player", name);
        JsonArray completed = new JsonArray();
        JsonArray unclaimed = new JsonArray();
        out.add("completed", completed);
        out.add("unclaimed", unclaimed);
        UUID who;
        try {
            who = player(name);
        } catch (RpcException unknown) {
            out.addProperty("known", false);
            return out;
        }
        for (Map.Entry<UUID, IQuest> e : new ArrayList<>(QuestDatabase.INSTANCE.entrySet())) {
            IQuest q = e.getValue();
            if (!q.isComplete(who)) continue;
            String id = shortId(e.getKey());
            completed.add(new JsonPrimitive(id));
            if (!q.hasClaimed(who) && q.getRewards()
                .size() > 0) unclaimed.add(new JsonPrimitive(id));
        }
        return out;
    }

    /** Which chapter each quest is in (the first one, for quests shown in several). */
    private static Map<UUID, String> chapters() {
        Map<UUID, String> out = new HashMap<>();
        for (Map.Entry<UUID, IQuestLine> line : QuestLineDatabase.INSTANCE.getOrderedEntries()) {
            String title = plain(QuestTranslation.translateQuestLineName(line));
            for (UUID quest : new ArrayList<>(
                line.getValue()
                    .keySet())) {
                if (!out.containsKey(quest)) out.put(quest, title);
            }
        }
        return out;
    }

    public static JsonObject lines(UUID who) {
        JsonArray lines = new JsonArray();
        for (Map.Entry<UUID, IQuestLine> line : QuestLineDatabase.INSTANCE.getOrderedEntries()) {
            JsonObject o = new JsonObject();
            o.addProperty("name", plain(QuestTranslation.translateQuestLineName(line)));
            int total = 0, complete = 0, available = 0;
            for (UUID id : new ArrayList<>(
                line.getValue()
                    .keySet())) {
                IQuest q = QuestDatabase.INSTANCE.get(id);
                if (q == null) continue;
                total++;
                if (who == null) continue;
                if (q.isComplete(who)) complete++;
                else if (q.isUnlocked(who)) available++;
            }
            o.addProperty("quests", total);
            if (who != null) {
                o.addProperty("complete", complete);
                o.addProperty("available", available);
            }
            lines.add(o);
        }
        JsonObject out = new JsonObject();
        out.add("lines", lines);
        out.addProperty("quests", QuestDatabase.INSTANCE.size());
        return out;
    }

    /**
     * Quests by words in their title or text, by chapter, by state, or any mix of these.
     *
     * @param state "available", "complete", "locked" or null for any; needs {@code who}
     */
    public static JsonObject search(String query, String line, String state, UUID who, int limit) {
        if (state != null && who == null) throw RpcException.badRequest("state needs a player");
        String[] words = query == null || query.trim()
            .isEmpty() ? new String[0]
                : query.trim()
                    .toLowerCase(Locale.ROOT)
                    .split("\\s+");
        String wantLine = line == null ? null
            : line.trim()
                .toLowerCase(Locale.ROOT);
        Map<UUID, String> chapters = chapters();
        List<Object[]> hits = new ArrayList<>();
        for (Map.Entry<UUID, IQuest> e : new ArrayList<>(QuestDatabase.INSTANCE.entrySet())) {
            UUID id = e.getKey();
            IQuest q = e.getValue();
            String chapter = chapters.get(id);
            if (wantLine != null && (chapter == null || !chapter.toLowerCase(Locale.ROOT)
                .contains(wantLine))) continue;
            String st = state(q, who);
            if (state != null && (st == null || !st.startsWith(state))) continue;
            String title = name(id, q);
            int score = 0;
            if (words.length > 0) {
                String lowTitle = title.toLowerCase(Locale.ROOT);
                String lowText = null;
                boolean all = true;
                for (String w : words) {
                    if (lowTitle.contains(w)) continue;
                    if (lowText == null) lowText = description(id, q).toLowerCase(Locale.ROOT);
                    if (lowText.contains(w)) {
                        score += 10; // found only in the text: a weaker match than in the title
                        continue;
                    }
                    all = false;
                    break;
                }
                if (!all) continue;
                score += lowTitle.length() / 8;
            }
            hits.add(new Object[] { score, id, q, title, chapter, st });
        }
        Collections.sort(hits, (a, b) -> (Integer) a[0] - (Integer) b[0]);
        JsonArray quests = new JsonArray();
        for (Object[] h : hits) {
            if (quests.size() >= limit) break;
            JsonObject o = new JsonObject();
            o.addProperty("id", shortId((UUID) h[1]));
            o.addProperty("name", (String) h[3]);
            if (h[4] != null) o.addProperty("line", (String) h[4]);
            if (h[5] != null) o.addProperty("state", (String) h[5]);
            quests.add(o);
        }
        JsonObject out = new JsonObject();
        out.add("quests", quests);
        out.addProperty("total", hits.size());
        return out;
    }

    private static final String LEGACY = "00000000-0000-0000-0000-";

    /** Old quests carry a number dressed up as a UUID; that number alone is easier to pass around. */
    private static String shortId(UUID id) {
        String s = id.toString();
        if (!s.startsWith(LEGACY)) return s;
        String tail = s.substring(LEGACY.length())
            .replaceFirst("^0+", "");
        return tail.isEmpty() ? "0" : tail;
    }

    private static Map.Entry<UUID, IQuest> find(String id) {
        String want = id.trim()
            .toLowerCase(Locale.ROOT);
        UUID key;
        try {
            if (want.matches("[0-9a-f]{1,12}")) {
                key = UUID.fromString(LEGACY + "000000000000".substring(want.length()) + want);
            } else {
                key = UUID.fromString(want);
            }
        } catch (IllegalArgumentException e) {
            throw RpcException.badRequest("not a quest id: " + id);
        }
        IQuest q = QuestDatabase.INSTANCE.get(key);
        if (q == null) throw RpcException.notFound("there is no quest with id " + id);
        return new java.util.AbstractMap.SimpleImmutableEntry<>(key, q);
    }

    public static JsonObject get(String id, UUID who) {
        Map.Entry<UUID, IQuest> e = find(id);
        IQuest q = e.getValue();
        JsonObject o = new JsonObject();
        o.addProperty("id", shortId(e.getKey()));
        o.addProperty("name", name(e.getKey(), q));
        String chapter = chapters().get(e.getKey());
        if (chapter != null) o.addProperty("line", chapter);
        String text = description(e.getKey(), q);
        if (text.length() > 3000) text = text.substring(0, 3000) + " …";
        o.addProperty("description", text);
        String st = state(q, who);
        if (st != null) o.addProperty("state", st);

        JsonArray needs = new JsonArray();
        for (UUID req : q.getRequirements()) {
            IQuest r = QuestDatabase.INSTANCE.get(req);
            if (r == null) continue;
            JsonObject n = new JsonObject();
            n.addProperty("id", shortId(req));
            n.addProperty("name", name(req, r));
            if (who != null) n.addProperty("complete", r.isComplete(who));
            needs.add(n);
        }
        o.add("requires", needs);

        JsonArray tasks = new JsonArray();
        for (DBEntry<ITask> t : q.getTasks()
            .getEntries()) {
            ITask task = t.getValue();
            JsonObject j = new JsonObject();
            j.addProperty("type", kind(task.getUnlocalisedName()));
            if (who != null) j.addProperty("complete", task.isComplete(who));
            NBTTagCompound nbt = new NBTTagCompound();
            try {
                task.writeToNBT(nbt);
            } catch (Throwable ignored) {
                // Whatever it wrote before failing is still worth showing.
            }
            describeTask(j, nbt);
            tasks.add(j);
        }
        o.add("tasks", tasks);

        JsonArray rewards = new JsonArray();
        for (DBEntry<IReward> r : q.getRewards()
            .getEntries()) {
            IReward reward = r.getValue();
            JsonObject j = new JsonObject();
            j.addProperty("type", kind(reward.getUnlocalisedName()));
            NBTTagCompound nbt = new NBTTagCompound();
            try {
                reward.writeToNBT(nbt);
            } catch (Throwable ignored) {
                // As above.
            }
            JsonArray items = items(nbt, "rewards");
            if (items.size() == 0) items = items(nbt, "choices");
            if (items.size() > 0) j.add("items", items);
            rewards.add(j);
        }
        o.add("rewards", rewards);
        return o;
    }

    /** "bq_standard.task.retrieval" reads better as "retrieval". */
    private static String kind(String unlocalised) {
        if (unlocalised == null) return "unknown";
        int dot = unlocalised.lastIndexOf('.');
        return dot >= 0 && dot < unlocalised.length() - 1 ? unlocalised.substring(dot + 1) : unlocalised;
    }

    private static void describeTask(JsonObject j, NBTTagCompound nbt) {
        JsonArray items = items(nbt, "requiredItems");
        if (items.size() > 0) j.add("items", items);
        if (nbt.hasKey("consume")) j.addProperty("consumed", nbt.getBoolean("consume"));
        if (nbt.hasKey("requiredFluids", 9)) {
            JsonArray fluids = new JsonArray();
            NBTTagList list = nbt.getTagList("requiredFluids", 10);
            for (int i = 0; i < list.tagCount(); i++) {
                NBTTagCompound f = list.getCompoundTagAt(i);
                JsonObject o = new JsonObject();
                o.addProperty("fluid", f.getString("FluidName"));
                o.addProperty("mb", f.getInteger("Amount"));
                fluids.add(o);
            }
            if (fluids.size() > 0) j.add("fluids", fluids);
        }
        if (nbt.hasKey("target", 8)) {
            // Hunting tasks name a creature and how many.
            j.addProperty("target", nbt.getString("target"));
            if (nbt.hasKey("required")) j.addProperty("count", nbt.getInteger("required"));
        }
        if (nbt.hasKey("posX") && nbt.hasKey("posZ")) {
            JsonObject at = new JsonObject();
            at.addProperty("x", nbt.getInteger("posX"));
            at.addProperty("y", nbt.getInteger("posY"));
            at.addProperty("z", nbt.getInteger("posZ"));
            if (nbt.hasKey("dimension")) at.addProperty("dim", nbt.getInteger("dimension"));
            j.add("location", at);
        }
    }

    /** The items in one of the lists quest tasks and rewards keep, as the quest book stores them. */
    private static JsonArray items(NBTTagCompound nbt, String key) {
        JsonArray out = new JsonArray();
        if (!nbt.hasKey(key, 9)) return out;
        NBTTagList list = nbt.getTagList(key, 10);
        for (int i = 0; i < list.tagCount() && out.size() < 24; i++) {
            NBTTagCompound it = list.getCompoundTagAt(i);
            JsonObject o = new JsonObject();
            NBTBase rawId = it.getTag("id");
            Item item = null;
            if (rawId != null && rawId.getId() == 8) {
                String id = it.getString("id");
                o.addProperty("id", id);
                item = Names.item(id);
            } else if (rawId != null) {
                item = Item.getItemById(it.getShort("id"));
                if (item != null) o.addProperty("id", Names.itemId(item));
            }
            int meta = it.getShort("Damage");
            int count = it.hasKey("Count", 3) ? it.getInteger("Count") : it.getByte("Count");
            if (meta >= 0 && meta != 32767) o.addProperty("meta", meta);
            o.addProperty("count", Math.max(1, count));
            if (item != null) {
                try {
                    o.addProperty("name", new ItemStack(item, 1, meta == 32767 ? 0 : Math.max(0, meta)).getDisplayName());
                } catch (Throwable t) {
                    // The id is enough to look it up.
                }
            }
            String ore = it.getString("OreDict");
            if (ore != null && !ore.isEmpty()) o.addProperty("ore", ore);
            out.add(o);
        }
        return out;
    }
}
