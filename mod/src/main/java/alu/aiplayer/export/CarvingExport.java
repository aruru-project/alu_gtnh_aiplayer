package alu.aiplayer.export;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.util.EnumChatFormatting;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;

/**
 * Writes down what a chisel turns into what: the groups of the Chisel mod, each a set of blocks any of which can
 * be carved into any other. No recipe page shows these as recipes, and a building plan asks for particular
 * variants. Reached by name, so that the mod builds and runs without Chisel. Client only (for the names).
 */
final class CarvingExport {

    private CarvingExport() {}

    /** Returns how many groups were written; 0 when Chisel is not there. */
    static int run(File dir) throws Exception {
        Object registry;
        Method stackOf;
        try {
            Class<?> utils = Class.forName("com.cricketcraft.chisel.api.carving.CarvingUtils");
            registry = utils.getMethod("getChiselRegistry")
                .invoke(null);
            stackOf = utils.getMethod("getStack", Class.forName("com.cricketcraft.chisel.api.carving.ICarvingVariation"));
        } catch (Throwable t) {
            AiPlayerMod.LOG.info("export: no Chisel here, carving groups are left out");
            return 0;
        }
        if (registry == null) return 0;
        Class<?> registryType = Class.forName("com.cricketcraft.chisel.api.carving.ICarvingRegistry");
        Class<?> groupType = Class.forName("com.cricketcraft.chisel.api.carving.ICarvingGroup");
        List<?> names = (List<?>) registryType.getMethod("getSortedGroupNames")
            .invoke(registry);
        Method group = registryType.getMethod("getGroup", String.class);
        Method variations = groupType.getMethod("getVariations");
        Method ore = groupType.getMethod("getOreName");
        File tmp = new File(dir, "carving.jsonl.part");
        int written = 0;
        try (Writer w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(tmp), StandardCharsets.UTF_8), 1 << 16)) {
            for (Object name : names) {
                try {
                    Object g = group.invoke(registry, String.valueOf(name));
                    if (g == null) continue;
                    JsonArray variants = new JsonArray();
                    Set<String> seen = new HashSet<>();
                    for (Object v : (List<?>) variations.invoke(g)) {
                        ItemStack stack = (ItemStack) stackOf.invoke(null, v);
                        if (stack == null || stack.getItem() == null) continue;
                        String id = String.valueOf(Item.itemRegistry.getNameForObject(stack.getItem()));
                        if (!seen.add(id + "/" + stack.getItemDamage())) continue;
                        JsonObject o = new JsonObject();
                        o.addProperty("id", id);
                        o.addProperty("meta", stack.getItemDamage());
                        String shown;
                        try {
                            shown = EnumChatFormatting.getTextWithoutFormattingCodes(stack.getDisplayName());
                        } catch (Throwable t) {
                            shown = id;
                        }
                        o.addProperty("name", shown == null ? id : shown.trim());
                        variants.add(o);
                    }
                    if (variants.size() < 2) continue;
                    JsonObject o = new JsonObject();
                    o.addProperty("group", String.valueOf(name));
                    Object oreName = ore.invoke(g);
                    // Anything under this ore dictionary name can be carved into the group as well.
                    if (oreName != null && !String.valueOf(oreName)
                        .isEmpty()) o.addProperty("ore", String.valueOf(oreName));
                    o.add("variants", variants);
                    w.write(o.toString());
                    w.write('\n');
                    written++;
                } catch (Throwable t) {
                    AiPlayerMod.LOG.warn("export: carving group " + name + " could not be read", t);
                }
            }
        }
        java.nio.file.Files.move(
            tmp.toPath(),
            new File(dir, "carving.jsonl").toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        AiPlayerMod.LOG.info("export: {} carving groups", written);
        return written;
    }
}
