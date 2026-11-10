package alu.aiplayer.task;

import com.google.gson.JsonObject;

import alu.aiplayer.util.J;

/** Stands still for a number of ticks. */
public final class WaitTask extends Task {

    private int left;

    public WaitTask(JsonObject params) {
        super("wait", params);
        left = Math.max(1, Math.min(20 * 60 * 30, J.i(params, "ticks", 20)));
        progressTotal = left;
    }

    @Override
    public void tick() {
        progressDone++;
        if (--left <= 0) done();
    }
}
