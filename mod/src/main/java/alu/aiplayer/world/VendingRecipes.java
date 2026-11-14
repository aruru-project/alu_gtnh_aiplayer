package alu.aiplayer.world;

import java.util.Map;

import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.Names;
import alu.aiplayer.util.Nbt;

/** Read-only native trade rules, not a trade action or a claim that this player is eligible. */
public final class VendingRecipes {
    private VendingRecipes() {}

    public static JsonObject rules(String id, int meta) {
        JsonObject out = new JsonObject();
        JsonArray matches = new JsonArray();
        out.addProperty("source", "installed Vending Machine TradeDatabase");
        out.addProperty("scope", "static trade rules, not current player unlocks, wallet, remaining quota or cooldown");
        try {
            Class<?> dbClass = Class.forName("com.cubefury.vendingmachine.trade.TradeDatabase");
            Object db = dbClass.getField("INSTANCE").get(null);
            Map<?, ?> groups = (Map<?, ?>) dbClass.getMethod("getTradeGroups").invoke(db);
            for (Object group : groups.values()) {
                Class<?> gc = group.getClass();
                for (Object trade : (Iterable<?>) gc.getMethod("getTrades").invoke(group)) {
                    JsonArray products = items(trade, "toItems");
                    boolean found = false;
                    for (com.google.gson.JsonElement e : products) {
                        JsonObject product = e.getAsJsonObject();
                        if (product.has("id") && id.equals(product.get("id").getAsString()) && (meta < 0 || meta == product.get("meta").getAsInt())) found = true;
                    }
                    if (!found) continue;
                    JsonObject r = new JsonObject();
                    r.addProperty("group", gc.getMethod("getId").invoke(group).toString());
                    r.addProperty("cooldownSeconds", gc.getField("cooldown").getInt(group));
                    r.addProperty("maxTrades", gc.getField("maxTrades").getInt(group));
                    r.add("products", products);
                    r.add("inputs", items(trade, "fromItems"));
                    r.add("nonConsumedItems", items(trade, "nonConsumedItems"));
                    JsonArray currency = new JsonArray();
                    for (Object cost : (Iterable<?>) trade.getClass().getField("fromCurrency").get(trade)) currency.add(saved(cost));
                    r.add("currency", currency);
                    JsonArray requirements = new JsonArray();
                    for (Object condition : (Iterable<?>) gc.getMethod("getRequirements").invoke(group)) requirements.add(saved(condition));
                    r.add("requirements", requirements);
                    matches.add(r);
                }
            }
        } catch (ClassNotFoundException e) {
            out.addProperty("unavailable", "Vending Machine is not installed");
        } catch (ReflectiveOperationException e) {
            throw new RpcException("invalid", "cannot read the native trade rules: " + e);
        }
        out.add("trades", matches);
        return out;
    }

    private static com.google.gson.JsonElement saved(Object value) throws ReflectiveOperationException {
        NBTTagCompound tag = (NBTTagCompound) value.getClass().getMethod("writeToNBT", NBTTagCompound.class).invoke(value, new NBTTagCompound());
        Nbt.Limits limits = new Nbt.Limits();
        limits.depth = 30;
        limits.list = 10000;
        limits.chars = 1000000;
        com.google.gson.JsonElement json = Nbt.json(tag, limits);
        if (value.getClass().getName().equals("com.cubefury.vendingmachine.integration.betterquesting.BqCondition")) {
            // A string keeps UUID bits exact across JSON/JavaScript and can be used by get_quest.
            json.getAsJsonObject().addProperty("questId", value.getClass().getMethod("getQuestId").invoke(value).toString());
        }
        return json;
    }

    private static JsonArray items(Object trade, String field) throws ReflectiveOperationException {
        JsonArray out = new JsonArray();
        for (Object big : (Iterable<?>) trade.getClass().getField(field).get(trade)) {
            ItemStack stack = (ItemStack) big.getClass().getMethod("getBaseStack").invoke(big);
            JsonObject item = stack == null ? new JsonObject() : Names.describe(stack);
            item.addProperty("count", big.getClass().getField("stackSize").getInt(big));
            if ((Boolean) big.getClass().getMethod("hasOreDict").invoke(big)) item.addProperty("ore", (String) big.getClass().getMethod("getOreDict").invoke(big));
            // The native serialized item preserves data-bearing outputs and their exact identity.
            item.add("native", saved(big));
            out.add(item);
        }
        return out;
    }
}
