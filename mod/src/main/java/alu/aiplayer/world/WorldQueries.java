package alu.aiplayer.world;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.entity.Entity;
import net.minecraft.entity.item.EntityItem;
import net.minecraft.entity.monster.IMob;
import net.minecraft.entity.passive.EntityAnimal;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.inventory.IInventory;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;
import net.minecraft.world.WorldServer;
import net.minecraft.world.chunk.Chunk;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.nav.NavWorld;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/** Read-only views of the world for the brain. None of them load or generate chunks. */
public final class WorldQueries {

    private WorldQueries() {}

    public static JsonObject block(World w, int x, int y, int z) {
        JsonObject o = J.pos(x, y, z);
        if (y < 0 || y > 255 || !w.blockExists(x, y, z)) {
            o.addProperty("loaded", false);
            return o;
        }
        Block b = w.getBlock(x, y, z);
        int meta = w.getBlockMetadata(x, y, z);
        o.addProperty("id", Names.blockId(b));
        o.addProperty("meta", meta);
        o.addProperty("name", blockName(b, meta));
        o.addProperty("air", b.isAir(w, x, y, z));
        o.addProperty(
            "solid",
            b.getMaterial()
                .isSolid());
        o.addProperty(
            "liquid",
            b.getMaterial()
                .isLiquid());
        o.addProperty("replaceable", b.isReplaceable(w, x, y, z));
        o.addProperty("hardness", J.round(b.getBlockHardness(w, x, y, z)));
        TileEntity te = w.getTileEntity(x, y, z);
        o.addProperty("tileEntity", te != null);
        o.addProperty("inventory", te instanceof IInventory);
        return o;
    }

    public static String blockName(Block b, int meta) {
        try {
            Item item = Item.getItemFromBlock(b);
            if (item != null) return new ItemStack(item, 1, meta).getDisplayName();
            return b.getLocalizedName();
        } catch (Throwable t) {
            return Names.blockId(b);
        }
    }

    /**
     * True for blocks that count as terrain surface: liquids and anything the bot would bump into, except foliage.
     * Thin covers such as a snow layer do not count; the ground under them does.
     */
    public static boolean isSurface(World w, Block b, int x, int y, int z) {
        Material m = b.getMaterial();
        if (m == Material.air || m == Material.leaves || m == Material.plants || m == Material.vine) return false;
        return NavWorld.classify(w, x, y, z) != NavWorld.OPEN;
    }

    /** The y of the highest surface block in a column, or -1. Leaves, plants and thin snow do not count. */
    public static int surfaceY(World w, int x, int z) {
        Chunk chunk = w.getChunkFromBlockCoords(x, z);
        int top = Math.min(255, chunk.getTopFilledSegment() + 15);
        for (int y = top; y >= 0; y--) {
            Block b = chunk.getBlock(x & 15, y, z & 15);
            if (b.getMaterial() == Material.air) continue;
            if (isSurface(w, b, x, y, z)) return y;
        }
        return -1;
    }

    public static JsonObject scan(World w, int ax, int az, int bx, int bz) {
        int x1 = Math.min(ax, bx), x2 = Math.max(ax, bx), z1 = Math.min(az, bz), z2 = Math.max(az, bz);
        if ((long) x2 - x1 + 1 > 64 || (long) z2 - z1 + 1 > 64) {
            throw RpcException.tooLarge("scan area is limited to 64x64 columns");
        }
        JsonObject o = new JsonObject();
        o.addProperty("x1", x1);
        o.addProperty("z1", z1);
        o.addProperty("x2", x2);
        o.addProperty("z2", z2);
        Map<String, Integer> palette = new LinkedHashMap<>();
        JsonArray heights = new JsonArray();
        JsonArray tops = new JsonArray();
        int minY = Integer.MAX_VALUE, maxY = -1, unloaded = 0, liquid = 0, counted = 0;
        long sum = 0;
        int[] histogram = new int[256];
        for (int z = z1; z <= z2; z++) {
            JsonArray hRow = new JsonArray();
            JsonArray tRow = new JsonArray();
            for (int x = x1; x <= x2; x++) {
                if (!w.blockExists(x, 64, z)) {
                    unloaded++;
                    hRow.add(J.prim(-1));
                    tRow.add(J.prim(-1));
                    continue;
                }
                int y = surfaceY(w, x, z);
                hRow.add(J.prim(y));
                if (y < 0) {
                    tRow.add(J.prim(-1));
                    continue;
                }
                Block b = w.getBlock(x, y, z);
                if (b.getMaterial()
                    .isLiquid()) liquid++;
                String id = Names.blockId(b);
                Integer idx = palette.get(id);
                if (idx == null) {
                    idx = palette.size();
                    palette.put(id, idx);
                }
                tRow.add(J.prim(idx));
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
                sum += y;
                counted++;
                histogram[y]++;
            }
            heights.add(hRow);
            tops.add(tRow);
        }
        o.add("heights", heights);
        o.add("tops", tops);
        JsonArray pal = new JsonArray();
        JsonArray liquids = new JsonArray();
        for (Map.Entry<String, Integer> e : palette.entrySet()) {
            pal.add(J.prim(e.getKey()));
            Block pb = Names.block(e.getKey());
            if (pb != null && pb.getMaterial()
                .isLiquid()) liquids.add(J.prim(e.getValue()));
        }
        o.add("palette", pal);
        o.add("liquidPalette", liquids);
        JsonObject stats = new JsonObject();
        int mode = -1;
        for (int y = 0; y < 256; y++) if (mode < 0 || histogram[y] > histogram[mode]) mode = y;
        stats.addProperty("minY", counted == 0 ? -1 : minY);
        stats.addProperty("maxY", maxY);
        stats.addProperty("modeY", counted == 0 ? -1 : mode);
        stats.addProperty("meanY", counted == 0 ? -1 : J.round((double) sum / counted));
        stats.addProperty("columns", (x2 - x1 + 1) * (z2 - z1 + 1));
        stats.addProperty("unloaded", unloaded);
        o.add("stats", stats);
        o.addProperty("liquidColumns", liquid);
        JsonArray tes = new JsonArray();
        for (TileEntity te : tileEntities(w, x1, z1, x2, z2)) {
            if (tes.size() >= 64) break;
            JsonObject t = J.pos(te.xCoord, te.yCoord, te.zCoord);
            t.addProperty("id", Names.blockId(te.getBlockType()));
            tes.add(t);
        }
        o.add("tileEntities", tes);
        return o;
    }

    /** Tile entities in loaded chunks whose x/z fall inside the rectangle. */
    public static List<TileEntity> tileEntities(World w, int x1, int z1, int x2, int z2) {
        List<TileEntity> out = new ArrayList<>();
        for (int cx = x1 >> 4; cx <= x2 >> 4; cx++) {
            for (int cz = z1 >> 4; cz <= z2 >> 4; cz++) {
                if (!w.getChunkProvider()
                    .chunkExists(cx, cz)) continue;
                Chunk chunk = w.getChunkFromChunkCoords(cx, cz);
                for (Object v : new ArrayList<Object>(chunk.chunkTileEntityMap.values())) {
                    TileEntity te = (TileEntity) v;
                    if (te.isInvalid()) continue;
                    if (te.xCoord >= x1 && te.xCoord <= x2 && te.zCoord >= z1 && te.zCoord <= z2) out.add(te);
                }
            }
        }
        return out;
    }

    public static JsonObject find(World w, int cx, int cy, int cz, int radius, Set<Block> wanted, int limit) {
        if (radius > 48) throw RpcException.tooLarge("radius is limited to 48");
        final int fx = cx, fy = cy, fz = cz;
        // Only the nearest few are wanted; a common block can match hundreds of thousands of cells.
        PriorityQueue<int[]> nearest = new PriorityQueue<>(
            limit + 1,
            (a, b) -> Long.compare(dist2(b, fx, fy, fz), dist2(a, fx, fy, fz)));
        int total = 0;
        int yLo = Math.max(0, cy - radius), yHi = Math.min(255, cy + radius);
        for (int chX = (cx - radius) >> 4; chX <= (cx + radius) >> 4; chX++) {
            for (int chZ = (cz - radius) >> 4; chZ <= (cz + radius) >> 4; chZ++) {
                if (!w.getChunkProvider()
                    .chunkExists(chX, chZ)) continue;
                Chunk chunk = w.getChunkFromChunkCoords(chX, chZ);
                int top = Math.min(yHi, chunk.getTopFilledSegment() + 15);
                for (int y = yLo; y <= top; y++) {
                    for (int lx = 0; lx < 16; lx++) {
                        int x = (chX << 4) + lx;
                        if (x < cx - radius || x > cx + radius) continue;
                        for (int lz = 0; lz < 16; lz++) {
                            int z = (chZ << 4) + lz;
                            if (z < cz - radius || z > cz + radius) continue;
                            if (!wanted.contains(chunk.getBlock(lx, y, lz))) continue;
                            total++;
                            int[] hit = { x, y, z };
                            if (nearest.size() < limit) {
                                nearest.add(hit);
                            } else if (dist2(hit, fx, fy, fz) < dist2(nearest.peek(), fx, fy, fz)) {
                                nearest.poll();
                                nearest.add(hit);
                            }
                        }
                    }
                }
            }
        }
        List<int[]> hits = new ArrayList<>(nearest);
        Collections.sort(hits, (a, b) -> Long.compare(dist2(a, fx, fy, fz), dist2(b, fx, fy, fz)));
        JsonArray matches = new JsonArray();
        for (int[] h : hits) {
            JsonObject m = J.pos(h[0], h[1], h[2]);
            m.addProperty("id", Names.blockId(w.getBlock(h[0], h[1], h[2])));
            m.addProperty("meta", w.getBlockMetadata(h[0], h[1], h[2]));
            m.addProperty("dist", J.round(Math.sqrt(dist2(h, fx, fy, fz))));
            matches.add(m);
        }
        JsonObject o = new JsonObject();
        o.add("matches", matches);
        o.addProperty("total", total);
        return o;
    }

    private static long dist2(int[] p, int x, int y, int z) {
        long dx = p[0] - x, dy = p[1] - y, dz = p[2] - z;
        return dx * dx + dy * dy + dz * dz;
    }

    public static JsonObject containers(World w, int cx, int cy, int cz, int radius) {
        if (radius > 32) throw RpcException.tooLarge("radius is limited to 32");
        List<TileEntity> found = new ArrayList<>();
        for (TileEntity te : tileEntities(w, cx - radius, cz - radius, cx + radius, cz + radius)) {
            if (te instanceof IInventory && Math.abs(te.yCoord - cy) <= radius) found.add(te);
        }
        final int fx = cx, fy = cy, fz = cz;
        Collections.sort(
            found,
            (a, b) -> Long.compare(
                dist2(new int[] { a.xCoord, a.yCoord, a.zCoord }, fx, fy, fz),
                dist2(new int[] { b.xCoord, b.yCoord, b.zCoord }, fx, fy, fz)));
        JsonArray list = new JsonArray();
        for (TileEntity te : found) {
            if (list.size() >= 40) break;
            list.add(describeContainer(w, te));
        }
        JsonObject o = new JsonObject();
        o.add("containers", list);
        o.addProperty("total", found.size());
        return o;
    }

    public static JsonObject describeContainer(World w, TileEntity te) {
        IInventory inv = (IInventory) te;
        JsonObject c = J.pos(te.xCoord, te.yCoord, te.zCoord);
        Block b = te.getBlockType();
        c.addProperty("id", Names.blockId(b));
        c.addProperty("name", blockName(b, te.getBlockMetadata()));
        int size = 0, used = 0;
        Map<String, JsonObject> merged = new LinkedHashMap<>();
        try {
            size = inv.getSizeInventory();
            for (int i = 0; i < size; i++) {
                ItemStack s = inv.getStackInSlot(i);
                if (s == null || s.stackSize <= 0) continue;
                used++;
                String key = Names.itemId(s.getItem()) + "@" + Names.meta(s);
                JsonObject item = merged.get(key);
                if (item == null) {
                    item = Names.describe(s);
                    item.remove("durability");
                    merged.put(key, item);
                } else {
                    item.addProperty(
                        "count",
                        item.get("count")
                            .getAsInt() + s.stackSize);
                }
            }
        } catch (Throwable t) {
            c.addProperty("unreadable", true);
        }
        c.addProperty("slots", size);
        c.addProperty("usedSlots", used);
        JsonArray items = new JsonArray();
        for (JsonObject item : merged.values()) {
            if (items.size() >= 60) break;
            items.add(item);
        }
        c.add("items", items);
        return c;
    }

    public static JsonObject entities(WorldServer w, double cx, double cy, double cz, int radius) {
        if (radius > 64) throw RpcException.tooLarge("radius is limited to 64");
        AxisAlignedBB box = AxisAlignedBB
            .getBoundingBox(cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius);
        List<Entity> found = new ArrayList<>();
        Set<Integer> loadedOnly = new HashSet<>();
        for (Object e : w.getEntitiesWithinAABB(Entity.class, box)) {
            Entity en = (Entity) e;
            if (en.isDead || !loadedOnly.add(en.getEntityId())) continue;
            found.add(en);
        }
        final double fx = cx, fy = cy, fz = cz;
        Collections
            .sort(found, (a, b) -> Double.compare(a.getDistanceSq(fx, fy, fz), b.getDistanceSq(fx, fy, fz)));
        JsonArray list = new JsonArray();
        for (Entity en : found) {
            if (list.size() >= 80) break;
            JsonObject o = new JsonObject();
            String type;
            if (en instanceof EntityPlayer) type = "player";
            else if (en instanceof IMob) type = "mob";
            else if (en instanceof EntityAnimal) type = "animal";
            else if (en instanceof EntityItem) type = "item";
            else type = "other";
            o.addProperty("type", type);
            o.addProperty("name", en.getCommandSenderName());
            o.add("pos", J.pos(en.posX, en.posY, en.posZ));
            o.addProperty("dist", J.round(Math.sqrt(en.getDistanceSq(cx, cy, cz))));
            if (en instanceof EntityItem) {
                ItemStack s = ((EntityItem) en).getEntityItem();
                if (s != null) o.add("item", Names.describe(s));
            }
            list.add(o);
        }
        JsonObject o = new JsonObject();
        o.add("entities", list);
        o.addProperty("total", found.size());
        return o;
    }
}
