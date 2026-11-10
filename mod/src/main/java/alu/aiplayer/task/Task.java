package alu.aiplayer.task;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;

/**
 * Something a bot spends game time on. A task is created from its JSON params, ticked once per server tick while
 * it is the bot's active task, and ends itself by calling {@link #done} or {@link #fail}.
 * <p>
 * Tasks keep no state that must survive a restart beyond their params: on reload they start again and work out
 * from the world what is left to do.
 */
public abstract class Task {

    public enum State {
        QUEUED,
        RUNNING,
        DONE,
        FAILED,
        CANCELED
    }

    public String id;
    public final String type;
    public final JsonObject params;
    public State state = State.QUEUED;
    public long createdAt = System.currentTimeMillis();
    public long startedAt;
    public long finishedAt;

    protected Bot bot;
    protected int progressDone;
    protected int progressTotal;
    protected String phase = "";
    protected String note = "";
    private JsonObject result;
    private String errorCode;
    private String errorMessage;
    private JsonObject errorDetail;

    protected Task(String type, JsonObject params) {
        this.type = type;
        this.params = params;
    }

    /** Called once when the task becomes the active one. */
    public void start(Bot bot) {
        this.bot = bot;
    }

    /** The dimension the task started in. */
    public int startDim;

    /** Whether the task is tied to the place it started in; a bot carried to another dimension then stops. */
    public boolean dimensionBound() {
        return true;
    }

    /**
     * Whether a destination is within walking distance. Fails the task and returns false when it is not, so a
     * mistyped coordinate cannot send the bot off across the map, generating terrain as it goes.
     */
    protected final boolean withinTravel(int x, int z) {
        int max = bot.manager()
            .config().maxTravel;
        long dx = (long) x - bot.blockX(), dz = (long) z - bot.blockZ();
        if (dx * dx + dz * dz <= (long) max * max) return true;
        fail(
            "unreachable",
            "that is " + (long) Math.sqrt((double) dx * dx + (double) dz * dz)
                + " blocks away and the bot walks at most "
                + max
                + "; teleport closer first");
        return false;
    }

    /** Called every server tick while running. */
    public abstract void tick();

    /** Called once when the task stops for any reason; release whatever it holds (open chests, digging). */
    public void cleanup() {}

    /** What has been accomplished so far; reported for finished, failed and canceled tasks alike. */
    protected JsonObject summary() {
        return null;
    }

    public final boolean finished() {
        return state == State.DONE || state == State.FAILED || state == State.CANCELED;
    }

    protected final void done() {
        if (finished()) return;
        state = State.DONE;
        result = summary();
    }

    protected final void fail(String code, String message) {
        fail(code, message, null);
    }

    protected final void fail(String code, String message, JsonObject detail) {
        if (finished()) return;
        state = State.FAILED;
        errorCode = code;
        errorMessage = message;
        errorDetail = detail;
        result = summary();
    }

    public final void failExternally(String code, String message) {
        fail(code, message, null);
    }

    public final void cancel() {
        if (finished()) return;
        state = State.CANCELED;
        result = summary();
    }

    public final JsonObject info() {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("type", type);
        o.add("params", params);
        o.addProperty(
            "state",
            state.name()
                .toLowerCase());
        JsonObject p = new JsonObject();
        p.addProperty("done", progressDone);
        p.addProperty("total", progressTotal);
        p.addProperty("phase", phase);
        p.addProperty("note", note);
        o.add("progress", p);
        o.addProperty("createdAt", createdAt);
        if (startedAt > 0) o.addProperty("startedAt", startedAt);
        if (finishedAt > 0) o.addProperty("finishedAt", finishedAt);
        JsonObject r = finished() ? result : summary();
        if (r != null) o.add("result", r);
        if (errorCode != null) {
            JsonObject e = new JsonObject();
            e.addProperty("code", errorCode);
            e.addProperty("message", errorMessage);
            if (errorDetail != null) e.add("detail", errorDetail);
            o.add("error", e);
        }
        return o;
    }
}
