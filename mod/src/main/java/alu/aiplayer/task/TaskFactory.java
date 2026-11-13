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
            case "goto":
                return new GotoTask(params);
            case "goto_player":
                return new GotoPlayerTask(params);
            case "follow":
                return new FollowTask(params);
            case "home":
                return new HomeTask(params);
            case "dig":
                return new DigTask(params);
            case "place":
                return new PlaceTask(params);
            case "clear":
                return new ClearTask(params);
            case "fill":
                return new FillTask(params);
            case "flatten":
                return new FlattenTask(params);
            case "deposit":
                return new DepositTask(params);
            case "withdraw":
                return new WithdrawTask(params);
            case "haul":
                return new HaulTask(params);
            case "collect":
                return new CollectTask(params);
            case "give":
                return new GiveTask(params);
            case "blueprint":
                return new BlueprintTask(params);
            case "craft":
                return new CraftTask(params);
            case "process":
                return new ProcessTask(params);
            case "use":
                return params.has("entity") ? new EntityUseTask(params) : new UseTask(params);
            case "hold":
                return new HoldTask(params);
            default:
                throw RpcException.badRequest("unknown task type: " + type);
        }
    }
}
