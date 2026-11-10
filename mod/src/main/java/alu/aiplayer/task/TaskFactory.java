package alu.aiplayer.task;

import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;

/** Builds tasks from their protocol description. Constructors validate params and throw on bad input. */
public final class TaskFactory {

    private TaskFactory() {}

    public static Task create(String type, JsonObject params) {
        if (params == null) params = new JsonObject();
        switch (type) {
            case "wait":
                return new WaitTask(params);
            default:
                throw RpcException.badRequest("unknown task type: " + type);
        }
    }
}
