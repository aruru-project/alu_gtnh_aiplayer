package alu.aiplayer.bot;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import net.minecraft.entity.item.EntityItem;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.Names;
import alu.aiplayer.world.Quests;
import betterquesting.api.api.QuestingAPI;
import betterquesting.api.properties.NativeProps;
import betterquesting.api.questing.IQuest;
import betterquesting.api.questing.rewards.IReward;
import betterquesting.api.questing.tasks.ITask;
import betterquesting.api.utils.BigItemStack;
import betterquesting.api.utils.NBTConverter;
import betterquesting.api2.storage.DBEntry;
import betterquesting.core.BetterQuesting;
import betterquesting.network.PacketAssembly;
import betterquesting.network.PacketQuesting;
import betterquesting.questing.QuestDatabase;
import bq_standard.rewards.RewardChoice;
import bq_standard.tasks.TaskCheckbox;

/**
 * BetterQuesting's client parts. The quest book is a screen drawn only by the game client (the book item's
 * right-click, ItemQuestBook.onItemRightClick, and its key exist only there and open GuiHome); the server has no
 * screen and no container for it. A player does four things in it, each a click that makes the client send the
 * server one of the mod's messages over its channel (BQ_NET_CHAN, the NBT compressed and cut into pieces by
 * PacketAssembly):
 * <ul>
 * <li>a quest's Detect/Submit button (GuiQuest, NetQuestAction.requestDetect): {@code betterquesting:quest_action},
 * action 1;</li>
 * <li>its Claim button (NetQuestAction.requestClaim): the same message, action 0;</li>
 * <li>the box of a checkbox task (PanelTaskCheckbox, NetTaskCheckbox.requestClick): {@code bq_standard:task_checkbox};</li>
 * <li>one of the items of a choice reward (PanelRewardChoice, NetRewardChoice.requestChoice):
 * {@code bq_standard:choice_reward}.</li>
 * </ul>
 * The body sends these messages as that client does and hands them to the server's handler of the channel, then
 * reports what could be seen to change. Tasks and rewards are given by their place in the quest's lists (the order
 * quest.get lists them, which is the book's own); the messages carry the book's ids for them, which are not always
 * 0, 1, 2...
 */
public final class BetterQuestingClient implements ModClient {

    private static final String QUEST_ACTION = "betterquesting:quest_action";
    private static final String CHECKBOX = "bq_standard:task_checkbox";
    private static final String CHOICE = "bq_standard:choice_reward";
    /** NetQuestAction's action codes. */
    private static final int CLAIM = 0, DETECT = 1;

    static final String KEY = "key.betterquesting.quests";

    // ---- ModClient: nothing of it reaches the server except the screen's buttons ----------------------------------

    @Override
    public void keys(JsonArray out) {}

    @Override
    public boolean press(Bot bot, String key) {
        return false;
    }

    @Override
    public void usedInAir(BotConnection conn, ItemStack held) {}

    @Override
    public void tick(Bot bot, EntityPlayerMP p) {}

    @Override
    public void worn(EntityPlayerMP p, List<Worn> out) {}

    @Override
    public void controls(Container c, JsonArray out) {}

    @Override
    public boolean pressControl(Bot bot, Container c, String key) {
        return false;
    }

    @Override
    public void clientScreens(JsonArray out) {
        JsonObject o = new JsonObject();
        o.addProperty("screen", "the quest book (BetterQuesting)");
        JsonObject item = new JsonObject();
        item.addProperty("id", "questbook:ItemQuestBook");
        o.add("item", item);
        o.addProperty("key", KEY);
        o.addProperty("keyName", "Open Quests");
        JsonArray instead = new JsonArray();
        for (String m : new String[] { "quest.submit", "quest.check", "quest.choose", "quest.claim" }) instead.add(new JsonPrimitive(m));
        o.add("instead", instead);
        out.add(o);
    }

    // ---- the buttons --------------------------------------------------------------------------------------------

    /** The quest screen's Detect/Submit button. */
    public JsonObject submit(Bot bot, String id) {
        Map.Entry<UUID, IQuest> e = Quests.find(id);
        IQuest q = e.getValue();
        EntityPlayerMP p = idle(bot);
        UUID who = QuestingAPI.getQuestingUUID(p);
        if (!q.canSubmit(p)) return notPressed(e, who, "Detect/Submit", whyNoSubmit(q, who));
        Seen before = new Seen(bot, q, who);
        NBTTagCompound m = new NBTTagCompound();
        m.setInteger("action", DETECT);
        m.setTag("questIDs", NBTConverter.UuidValueType.QUEST.writeIds(Collections.singletonList(e.getKey())));
        send(bot, QUEST_ACTION, m);
        JsonObject o = after(bot, e, who, before, true);
        if (!q.isUnlocked(who)) {
            o.addProperty(
                "note",
                "the quest is locked: the quest book takes a submission only for an unlocked quest, so nothing was looked at; it needs "
                    + missingRequirements(q, who));
        }
        return o;
    }

    /** The box of a checkbox task; {@code task} is its place in the quest's tasks, from 0. */
    public JsonObject check(Bot bot, String id, int task) {
        Map.Entry<UUID, IQuest> e = Quests.find(id);
        IQuest q = e.getValue();
        List<DBEntry<ITask>> tasks = q.getTasks()
            .getEntries();
        if (task < 0 || task >= tasks.size()) {
            throw RpcException.badRequest("the quest has " + tasks.size() + " task(s), numbered from 0; there is no task " + task);
        }
        ITask t = tasks.get(task)
            .getValue();
        if (!(t instanceof TaskCheckbox)) {
            throw RpcException.badRequest("task " + task + " is a " + Quests.kind(t.getUnlocalisedName()) + " task, not a checkbox");
        }
        EntityPlayerMP p = idle(bot);
        UUID who = QuestingAPI.getQuestingUUID(p);
        if (t.isComplete(who)) return notPressed(e, who, "checkbox", "that checkbox is already ticked");
        Seen before = new Seen(bot, q, who);
        NBTTagCompound m = NBTConverter.UuidValueType.QUEST.writeId(e.getKey());
        m.setInteger(
            "taskID",
            tasks.get(task)
                .getID());
        send(bot, CHECKBOX, m);
        JsonObject o = after(bot, e, who, before, true);
        if (!q.isUnlocked(who) && !q.isComplete(who)) {
            o.addProperty(
                "note",
                "the quest is locked: the tick is kept and counts once the quest unlocks; it needs " + missingRequirements(q, who));
        }
        return o;
    }

    /**
     * Clicks one item of a choice reward: {@code reward} is the reward's place in the quest's rewards, {@code choice}
     * the item's place in that reward's list, both from 0.
     */
    public JsonObject choose(Bot bot, String id, int reward, int choice) {
        Map.Entry<UUID, IQuest> e = Quests.find(id);
        IQuest q = e.getValue();
        RewardChoice r = choiceReward(q, reward);
        if (choice < 0 || choice >= r.choices.size()) {
            throw RpcException.badRequest(
                "reward " + reward + " has " + r.choices.size() + " item(s) to choose from, numbered from 0; there is no " + choice);
        }
        EntityPlayerMP p = idle(bot);
        UUID who = QuestingAPI.getQuestingUUID(p);
        Seen before = new Seen(bot, q, who);
        NBTTagCompound m = NBTConverter.UuidValueType.QUEST.writeId(e.getKey());
        m.setInteger(
            "rewardID",
            q.getRewards()
                .getEntries()
                .get(reward)
                .getID());
        m.setInteger("selection", choice);
        send(bot, CHOICE, m);
        JsonObject o = after(bot, e, who, before, false);
        int now = r.getSelecton(who);
        JsonObject chosen = new JsonObject();
        chosen.addProperty("reward", reward);
        chosen.addProperty("choice", now);
        if (now >= 0 && now < r.choices.size()) chosen.add("item", stack(r.choices.get(now)));
        o.add("chosen", chosen);
        o.addProperty(
            "note",
            "the server keeps a choice in memory only, not in the save: if it restarts before the reward is claimed, the choice has to be made again");
        return o;
    }

    /** The quest screen's Claim button. */
    public JsonObject claim(Bot bot, String id) {
        Map.Entry<UUID, IQuest> e = Quests.find(id);
        IQuest q = e.getValue();
        EntityPlayerMP p = idle(bot);
        UUID who = QuestingAPI.getQuestingUUID(p);
        if (q.getRewards()
            .size() == 0 || !q.canClaim(p)) {
            JsonObject o = notPressed(e, who, "Claim", whyNoClaim(q, p, who));
            JsonArray choices = unchosen(q, who);
            if (choices.size() > 0) o.add("choices", choices);
            return o;
        }
        Seen before = new Seen(bot, q, who);
        NBTTagCompound m = new NBTTagCompound();
        m.setInteger("action", CLAIM);
        m.setTag("questIDs", NBTConverter.UuidValueType.QUEST.writeIds(Collections.singletonList(e.getKey())));
        send(bot, QUEST_ACTION, m);
        JsonObject o = after(bot, e, who, before, false);
        JsonArray also = new JsonArray();
        for (Map.Entry<UUID, IQuest> other : QuestDatabase.INSTANCE.entrySet()) {
            if (other.getKey()
                .equals(e.getKey()) || before.completed.contains(other.getKey())
                || !other.getValue()
                    .isComplete(who))
                continue;
            JsonObject j = new JsonObject();
            j.addProperty("id", Quests.shortId(other.getKey()));
            j.addProperty("name", Quests.name(other.getKey(), other.getValue()));
            also.add(j);
        }
        if (also.size() > 0) o.add("alsoComplete", also);
        return o;
    }

    // ---- what a press changed -----------------------------------------------------------------------------------

    /** What can be seen of the bot and the quest before a press, to tell what it changed. */
    private static final class Seen {

        final String state;
        final List<Boolean> complete = new ArrayList<>();
        final List<String> progress = new ArrayList<>();
        final Map<String, Integer> carried;
        final int level, points;
        final Set<UUID> completed = new HashSet<>();
        final Set<Integer> itemsAround;
        final long heard;

        Seen(Bot bot, IQuest q, UUID who) {
            EntityPlayerMP p = bot.player();
            state = Quests.state(q, who);
            for (DBEntry<ITask> t : q.getTasks()
                .getEntries()) {
                complete.add(
                    t.getValue()
                        .isComplete(who));
                JsonElement n = Quests.progress(t.getValue(), who);
                progress.add(n == null ? null : n.toString());
            }
            carried = carried(p);
            level = p.experienceLevel;
            points = p.experienceTotal;
            for (Map.Entry<UUID, IQuest> each : QuestDatabase.INSTANCE.entrySet()) {
                if (each.getValue()
                    .isComplete(who)) completed.add(each.getKey());
            }
            itemsAround = itemsAround(p).keySet();
            heard = bot.heardMark();
        }
    }

    private static JsonObject after(Bot bot, Map.Entry<UUID, IQuest> e, UUID who, Seen before, boolean tasks) {
        EntityPlayerMP p = bot.player();
        IQuest q = e.getValue();
        JsonObject o = new JsonObject();
        o.addProperty("pressed", true);
        JsonObject quest = quest(e, who);
        if (!quest.get("state")
            .getAsString()
            .equals(before.state)) quest.addProperty("was", before.state);
        o.add("quest", quest);
        if (tasks) {
            JsonArray list = new JsonArray();
            List<DBEntry<ITask>> entries = q.getTasks()
                .getEntries();
            for (int i = 0; i < entries.size(); i++) {
                ITask t = entries.get(i)
                    .getValue();
                JsonObject j = new JsonObject();
                j.addProperty("task", i);
                j.addProperty("type", Quests.kind(t.getUnlocalisedName()));
                boolean done = t.isComplete(who);
                j.addProperty("complete", done);
                if (i < before.complete.size() && before.complete.get(i) != done) j.addProperty("was", before.complete.get(i));
                if (t.ignored(who)) j.addProperty("optional", true);
                JsonElement n = Quests.progress(t, who);
                if (n != null) {
                    j.add("progress", n);
                    String was = i < before.progress.size() ? before.progress.get(i) : null;
                    if (was != null && !was.equals(n.toString())) j.add("progressWas", new com.google.gson.JsonParser().parse(was));
                }
                list.add(j);
            }
            o.add("tasks", list);
            // BetterQuesting marks the quest complete at its next check of the player (every 3 s), for an unlocked one.
            if (!q.isComplete(who) && q.isUnlocked(who) && Quests.tasksSatisfied(q, who)) o.addProperty("tasksDone", true);
        }
        Map<String, Integer> now = carried(p);
        JsonArray gained = new JsonArray(), lost = new JsonArray();
        for (Map.Entry<String, Integer> c : now.entrySet()) {
            int more = c.getValue() - (before.carried.containsKey(c.getKey()) ? before.carried.get(c.getKey()) : 0);
            if (more > 0) gained.add(change(c.getKey(), more));
        }
        for (Map.Entry<String, Integer> c : before.carried.entrySet()) {
            int fewer = c.getValue() - (now.containsKey(c.getKey()) ? now.get(c.getKey()) : 0);
            if (fewer > 0) lost.add(change(c.getKey(), fewer));
        }
        if (lost.size() > 0) o.add("lost", lost);
        if (gained.size() > 0) o.add("gained", gained);
        JsonArray dropped = new JsonArray();
        for (Map.Entry<Integer, ItemStack> d : itemsAround(p).entrySet()) {
            if (!before.itemsAround.contains(d.getKey())) dropped.add(Names.describe(d.getValue()));
        }
        if (dropped.size() > 0) o.add("dropped", dropped);
        if (p.experienceLevel != before.level || p.experienceTotal != before.points) {
            JsonObject xp = new JsonObject();
            xp.addProperty("levelWas", before.level);
            xp.addProperty("level", p.experienceLevel);
            xp.addProperty("pointsWas", before.points);
            xp.addProperty("points", p.experienceTotal);
            o.add("xp", xp);
        }
        JsonArray said = new JsonArray();
        for (String line : bot.heardSince(before.heard)) said.add(new JsonPrimitive(line));
        if (said.size() > 0) o.add("said", said);
        JsonObject party = Quests.party(who);
        if (party != null) o.add("party", party);
        o.addProperty("freeSlots", alu.aiplayer.act.Inventories.freeSlots(p));
        return o;
    }

    private static JsonObject quest(Map.Entry<UUID, IQuest> e, UUID who) {
        JsonObject quest = new JsonObject();
        quest.addProperty("id", Quests.shortId(e.getKey()));
        quest.addProperty("name", Quests.name(e.getKey(), e.getValue()));
        quest.addProperty("state", Quests.state(e.getValue(), who));
        return quest;
    }

    private static JsonObject notPressed(Map.Entry<UUID, IQuest> e, UUID who, String button, String why) {
        JsonObject o = new JsonObject();
        o.addProperty("pressed", false);
        o.addProperty("button", button);
        o.addProperty("why", why);
        o.add("quest", quest(e, who));
        JsonObject party = Quests.party(who);
        if (party != null) o.add("party", party);
        return o;
    }

    /** Why Detect/Submit is greyed out: what BetterQuesting's canSubmit looks at. */
    private static String whyNoSubmit(IQuest q, UUID who) {
        NBTTagCompound entry = q.getCompletionInfo(who);
        boolean repeatable = q.getProperty(NativeProps.REPEAT_TIME) >= 0;
        if (entry != null && entry.getBoolean("claimed")) {
            return "the quest is complete and its reward has been claimed" + (repeatable ? "; it can be done again once it resets" : "");
        }
        if (repeatable) return "all its tasks are done; the reward is waiting to be claimed";
        return q.getRewards()
            .size() > 0 ? "the quest is complete; its reward is waiting to be claimed" : "the quest is complete";
    }

    /** Why Claim is greyed out: what BetterQuesting's canClaim looks at, in its order. */
    private static String whyNoClaim(IQuest q, EntityPlayerMP p, UUID who) {
        if (q.getRewards()
            .size() == 0) return "the quest has no rewards";
        if (q.getCompletionInfo(who) == null) {
            String st = Quests.state(q, who);
            if (q.isUnlocked(who) && Quests.tasksSatisfied(q, who)) {
                return "the quest is not complete yet: its tasks are all done, and the quest book marks it complete at its next check of the player (every 3 s)";
            }
            return "the quest is not complete (" + st + ")" + ("locked".equals(st) ? "; it needs " + missingRequirements(q, who) : "");
        }
        if (q.hasClaimed(who)) return "the reward has already been claimed";
        if (q.canSubmit(p)) return "the quest is being done again (it repeats) and its tasks are not all done yet";
        Map.Entry<UUID, IQuest> self = new java.util.AbstractMap.SimpleImmutableEntry<>(QuestDatabase.INSTANCE.lookupKey(q), q);
        List<DBEntry<IReward>> rewards = q.getRewards()
            .getEntries();
        for (int i = 0; i < rewards.size(); i++) {
            IReward r = rewards.get(i)
                .getValue();
            if (r.canClaim(p, self)) continue;
            if (r instanceof RewardChoice && ((RewardChoice) r).getSelecton(who) < 0) {
                return "a reward is one to pick from and nothing is picked yet (choices lists it): pick one first; a pick is kept in the server's memory only, so a restart forgets it";
            }
            return "its " + Quests.kind(r.getUnlocalisedName()) + " reward says it cannot be claimed now";
        }
        return "the quest book does not let it be claimed now";
    }

    /** The choice rewards with nothing chosen: [{reward, items:[...]}]. */
    private static JsonArray unchosen(IQuest q, UUID who) {
        JsonArray out = new JsonArray();
        List<DBEntry<IReward>> rewards = q.getRewards()
            .getEntries();
        for (int i = 0; i < rewards.size(); i++) {
            IReward r = rewards.get(i)
                .getValue();
            if (!(r instanceof RewardChoice) || ((RewardChoice) r).getSelecton(who) >= 0) continue;
            JsonObject j = new JsonObject();
            j.addProperty("reward", i);
            JsonArray items = new JsonArray();
            for (BigItemStack s : ((RewardChoice) r).choices) items.add(stack(s));
            j.add("items", items);
            out.add(j);
        }
        return out;
    }

    private static String missingRequirements(IQuest q, UUID who) {
        StringBuilder s = new StringBuilder();
        for (UUID req : q.getRequirements()) {
            IQuest r = QuestDatabase.INSTANCE.get(req);
            if (r != null && r.isComplete(who)) continue;
            if (s.length() > 0) s.append(", ");
            s.append(Quests.shortId(req));
            if (r != null) s.append(" \"")
                .append(Quests.name(req, r))
                .append('"');
        }
        String logic = q.getProperty(NativeProps.LOGIC_QUEST)
            .toString();
        return (s.length() == 0 ? "its requirements (none missing?)" : s) + " (requirement logic " + logic + ")";
    }

    private static RewardChoice choiceReward(IQuest q, int reward) {
        List<DBEntry<IReward>> rewards = q.getRewards()
            .getEntries();
        if (reward < 0 || reward >= rewards.size()) {
            throw RpcException.badRequest("the quest has " + rewards.size() + " reward(s), numbered from 0; there is no reward " + reward);
        }
        IReward r = rewards.get(reward)
            .getValue();
        if (!(r instanceof RewardChoice)) {
            throw RpcException.badRequest("reward " + reward + " is a " + Quests.kind(r.getUnlocalisedName()) + " reward, not a choice");
        }
        return (RewardChoice) r;
    }

    private static JsonObject stack(BigItemStack s) {
        ItemStack base = s.getBaseStack();
        JsonObject o = Names.describe(base);
        o.addProperty("count", s.stackSize);
        return o;
    }

    /** The bot is online and doing nothing else: like the screens, the book is for an idle bot. */
    private static EntityPlayerMP idle(Bot bot) {
        if (!bot.tasks.idle()) throw new RpcException("busy", "a task is running; the quest book is for when the bot is idle");
        return bot.player();
    }

    /** Sends one of the mod's messages as its client does: ID set, compressed and cut by PacketAssembly. */
    private static void send(Bot bot, String handler, NBTTagCompound payload) {
        payload.setString("ID", handler);
        for (NBTTagCompound part : PacketAssembly.INSTANCE.splitPacket(payload)) {
            ModClients.send(bot.conn(), BetterQuesting.instance.network, new PacketQuesting(part));
        }
    }

    /** Everything in the player's inventory, armor included (a submission looks there too), by kind. */
    private static Map<String, Integer> carried(EntityPlayerMP p) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (int i = 0; i < p.inventory.getSizeInventory(); i++) {
            ItemStack s = p.inventory.getStackInSlot(i);
            if (s == null) continue;
            out.merge(Names.itemId(s.getItem()) + "@" + Names.meta(s) + "|" + Names.displayName(s), s.stackSize, Integer::sum);
        }
        return out;
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

    /** Items lying within a few blocks of the player: a reward that does not fit is dropped at its feet. */
    private static Map<Integer, ItemStack> itemsAround(EntityPlayerMP p) {
        Map<Integer, ItemStack> out = new LinkedHashMap<>();
        for (Object each : p.worldObj.getEntitiesWithinAABB(EntityItem.class, p.boundingBox.expand(4, 4, 4))) {
            EntityItem it = (EntityItem) each;
            if (it.isDead || it.getEntityItem() == null) continue;
            out.put(it.getEntityId(), it.getEntityItem());
        }
        return out;
    }
}
