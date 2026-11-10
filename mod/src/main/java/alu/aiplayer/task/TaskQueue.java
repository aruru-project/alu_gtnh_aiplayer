package alu.aiplayer.task;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.util.J;

/** A bot's active task, the tasks waiting behind it, and the last few that ended. */
public final class TaskQueue {

    public interface Listener {

        /** A task started or ended. */
        void onTaskUpdate(Bot bot, Task task);

        /** The set of pending tasks changed and should be saved. */
        void onQueueChanged(Bot bot);
    }

    private static final int RECENT = 10;
    private static long counter = System.currentTimeMillis() % 100000;

    private final Bot bot;
    private final Listener listener;
    private Task active;
    private final ArrayDeque<Task> queue = new ArrayDeque<>();
    private final ArrayDeque<JsonObject> recent = new ArrayDeque<>();

    public TaskQueue(Bot bot, Listener listener) {
        this.bot = bot;
        this.listener = listener;
    }

    public Task active() {
        return active;
    }

    public boolean idle() {
        return active == null && queue.isEmpty();
    }

    public Task add(Task task, boolean append) {
        if (!append) cancel(null);
        task.id = "t" + (++counter);
        queue.addLast(task);
        listener.onQueueChanged(bot);
        return task;
    }

    /** Cancels one task by id, or everything when id is null. Returns how many were canceled. */
    public int cancel(String id) {
        int n = 0;
        if (active != null && (id == null || id.equals(active.id))) {
            active.cancel();
            end(active);
            active = null;
            n++;
        }
        List<Task> keep = new ArrayList<>();
        for (Task t : queue) {
            if (id == null || id.equals(t.id)) {
                t.cancel();
                t.finishedAt = System.currentTimeMillis();
                remember(t);
                listener.onTaskUpdate(bot, t);
                n++;
            } else {
                keep.add(t);
            }
        }
        queue.clear();
        queue.addAll(keep);
        if (n > 0) listener.onQueueChanged(bot);
        return n;
    }

    /** Fails the running task and drops the queue, e.g. because the bot died. */
    public void interrupt(String message) {
        if (active != null) {
            active.failExternally("interrupted", message);
            end(active);
            active = null;
        }
        if (!queue.isEmpty()) cancel(null);
        listener.onQueueChanged(bot);
    }

    /** Lets a running task release what it holds without ending it; used when the bot goes offline. */
    public void suspend() {
        if (active == null) return;
        try {
            active.cleanup();
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Task cleanup failed", t);
        }
        // Back to the head of the queue: it starts afresh when the bot is online again.
        Task t = active;
        active = null;
        t.state = Task.State.QUEUED;
        queue.addFirst(t);
    }

    public void tick() {
        if (active == null) {
            active = queue.pollFirst();
            if (active == null) return;
            active.state = Task.State.RUNNING;
            active.startedAt = System.currentTimeMillis();
            try {
                active.start(bot);
            } catch (Throwable t) {
                AiPlayerMod.LOG.error("Task {} failed to start", active.type, t);
                active.failExternally("internal", String.valueOf(t));
            }
            listener.onTaskUpdate(bot, active);
        }
        if (!active.finished()) {
            try {
                active.tick();
            } catch (Throwable t) {
                AiPlayerMod.LOG.error("Task {} crashed", active.type, t);
                active.failExternally("internal", String.valueOf(t));
            }
        }
        if (active.finished()) {
            end(active);
            active = null;
            listener.onQueueChanged(bot);
        }
    }

    private void end(Task task) {
        try {
            task.cleanup();
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Task cleanup failed", t);
        }
        bot.motion.clear();
        task.finishedAt = System.currentTimeMillis();
        remember(task);
        listener.onTaskUpdate(bot, task);
    }

    private void remember(Task task) {
        recent.addFirst(task.info());
        while (recent.size() > RECENT) recent.removeLast();
    }

    public JsonElement activeInfo() {
        return active == null ? JsonNull.INSTANCE : active.info();
    }

    public JsonArray queueInfo() {
        JsonArray a = new JsonArray();
        for (Task t : queue) a.add(t.info());
        return a;
    }

    public JsonObject list() {
        JsonObject o = new JsonObject();
        o.add("active", activeInfo());
        o.add("queue", queueInfo());
        JsonArray r = new JsonArray();
        for (JsonObject t : recent) r.add(t);
        o.add("recent", r);
        return o;
    }

    /** Pending tasks in execution order, for the save file. */
    public JsonArray save() {
        JsonArray a = new JsonArray();
        if (active != null && !active.finished()) a.add(saveOne(active));
        for (Task t : queue) a.add(saveOne(t));
        return a;
    }

    private static JsonObject saveOne(Task t) {
        JsonObject o = new JsonObject();
        o.addProperty("id", t.id);
        o.addProperty("type", t.type);
        o.add("params", t.params);
        o.addProperty("createdAt", t.createdAt);
        return o;
    }

    public void load(JsonArray saved) {
        if (saved == null) return;
        for (JsonElement e : saved) {
            try {
                JsonObject o = e.getAsJsonObject();
                Task t = TaskFactory.create(J.reqStr(o, "type"), J.object(o, "params"));
                t.id = J.str(o, "id", "t" + (++counter));
                t.createdAt = J.l(o, "createdAt", t.createdAt);
                queue.addLast(t);
            } catch (Exception ex) {
                AiPlayerMod.LOG.warn("Dropping saved task that no longer loads: {}", e, ex);
            }
        }
    }
}
