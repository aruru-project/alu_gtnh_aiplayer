package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.init.Blocks;
import net.minecraft.inventory.Container;
import net.minecraft.inventory.InventoryCrafting;
import net.minecraft.inventory.Slot;
import net.minecraft.inventory.SlotCrafting;
import net.minecraft.item.ItemStack;
import net.minecraft.item.crafting.IRecipe;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.ContainerSession;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.craft.Layout;
import alu.aiplayer.craft.RecipeBook;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;
import alu.aiplayer.world.WorldQueries;

/**
 * Makes an item by hand: lays a recipe out on a crafting grid from what the bot carries and takes the result.
 * Small recipes go on the two-by-two grid every player has; larger ones need a crafting table, which the bot walks
 * to. Any block whose screen has a three-by-three crafting grid will do (the vanilla table, a Tinkers' crafting
 * station). The game itself decides what the laid-out grid yields, so a recipe that another mod changed or that needs
 * something unusual fails cleanly instead of producing the wrong thing.
 */
public final class CraftTask extends Task {

    private static final int TABLE_SEARCH = 48;

    /** A layout spelled out by the caller instead of one of the recipes this server knows by number. */
    private final JsonArray gridGiven;
    private final int rounds;
    private final String itemId;
    private final int meta;
    private final int recipeIndex;
    private final int wanted;
    private final int[] tableGiven;

    private Navigator nav;
    private Layout layout;
    private ItemStack expected;
    private int crafts;
    private int[] table;
    private Container grid;
    /** Slot numbers of the grid cells, row by row, and of the result. */
    private int[] gridSlots;
    private int resultSlot;
    private int gridWidth;
    private int stage;
    private int wait;
    private int cell;
    private int before;
    private int made;
    private String failCode, failMessage;
    private JsonObject failDetail;

    public CraftTask(JsonObject params) {
        super("craft", params);
        gridGiven = J.has(params, "grid") ? J.array(params, "grid") : null;
        if (gridGiven != null) {
            // Checked now, so that a slip in the layout is refused before the bot sets off.
            Layout.fromGrid(gridGiven, null);
            JsonObject gives = J.has(params, "gives") ? J.object(params, "gives") : null;
            itemId = gives == null ? null : J.reqStr(gives, "id");
            meta = gives == null ? 0 : Math.max(0, J.i(gives, "meta", 0));
            rounds = Math.max(1, Math.min(64, J.i(params, "rounds", 1)));
        } else {
            itemId = J.reqStr(params, "id");
            meta = Math.max(0, J.i(params, "meta", 0));
            rounds = 0;
        }
        if (itemId != null && Names.item(itemId) == null) throw new IllegalArgumentException("unknown item id: " + itemId);
        recipeIndex = Math.max(0, J.i(params, "recipe", 0));
        wanted = Math.max(1, Math.min(2304, J.i(params, "count", 1)));
        tableGiven = J.has(params, "table") ? Params.pos(params, "table") : null;
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        nav = new Navigator(bot);
        phase = "reading the recipe";
    }

    @Override
    public void cleanup() {
        if (nav != null) nav.stop();
        if (bot != null && bot.online() && grid != null && stage >= 3 && stage < 6) emptyGrid(bot.player());
    }

    @Override
    public void tick() {
        EntityPlayerMP p = bot.player();
        switch (stage) {
            case 0:
                prepare(p);
                break;
            case 1: {
                Navigator.Status st = nav.tick();
                if (st == Navigator.Status.WORKING) return;
                if (st == Navigator.Status.FAILED) {
                    fail(nav.failCode, "cannot get to the crafting table: " + nav.failMessage);
                    return;
                }
                World w = p.worldObj;
                if (w.isAirBlock(table[0], table[1], table[2])) {
                    fail("invalid", "there is no crafting table at that position", J.pos(table[0], table[1], table[2]));
                    return;
                }
                if (p.openContainer != p.inventoryContainer) bot.conn()
                    .closeWindow();
                ContainerSession.clickEmptyHanded(bot, table[0], table[1], table[2]);
                phase = "crafting";
                stage = 2;
                wait = 0;
                break;
            }
            case 2:
                if (bot.clickWasRefused(table[0], table[1], table[2])) {
                    fail("denied", bot.refused("using the crafting table"), bot.refusalDetail(table[0], table[1], table[2]));
                } else if (p.openContainer != p.inventoryContainer) {
                    if (!findGrid(p.openContainer) || gridWidth < 3) {
                        bot.conn()
                            .closeWindow();
                        fail("invalid", "that block has no three-by-three crafting grid");
                    } else if (!gridIsEmpty()) {
                        // Somebody's half-laid recipe; it is not the bot's to move.
                        grid = null;
                        bot.conn()
                            .closeWindow();
                        fail("invalid", "the crafting grid there is not empty; clear it or use another table");
                    } else {
                        stage = 3;
                        cell = 0;
                    }
                } else if (++wait > 10) {
                    fail("denied", "the crafting table did not open");
                }
                break;
            case 3:
                if (grid != p.inventoryContainer && p.openContainer != grid) {
                    fail("denied", "the crafting table closed while it was being used");
                    return;
                }
                if (++wait < 2) return;
                wait = 0;
                layOutNextCell(p);
                break;
            case 4:
                takeResult(p);
                stage = 5;
                break;
            case 5:
                emptyGrid(p);
                stage = 6;
                break;
            default:
                if (failCode != null) fail(failCode, failMessage, failDetail);
                else if (made <= 0) fail("invalid", "nothing came out of the grid");
                else done();
                break;
        }
    }

    private void prepare(EntityPlayerMP p) {
        if (!RecipeBook.isReady()) {
            // Right after a server start the index may still be in the making.
            RecipeBook.buildInBackground();
            if (++wait > 20 * 180) fail("internal", "the recipe index is not available");
            return;
        }
        RecipeBook book = RecipeBook.get();
        if (gridGiven != null) {
            layout = Layout.fromGrid(gridGiven, book);
            // What the grid gives is the game's to say. If the caller named it, anything else is a failure;
            // if not, whatever comes out the first time is what the rest must be too.
            expected = itemId == null ? null : new ItemStack(Names.item(itemId), 1, meta);
            crafts = rounds;
        } else {
            RecipeBook.Entry entry = book.entry(itemId, meta);
            if (entry == null || entry.crafting.isEmpty()) {
                fail("invalid", "no crafting-table recipe is known for " + itemId + "/" + meta);
                return;
            }
            if (recipeIndex >= entry.crafting.size()) {
                fail("invalid", "it has " + entry.crafting.size() + " crafting recipes; there is no number " + recipeIndex);
                return;
            }
            IRecipe recipe = entry.crafting.get(recipeIndex);
            layout = Layout.of(recipe, book);
            expected = recipe.getRecipeOutput();
            if (layout == null || expected == null) {
                fail("invalid", "this recipe is of a kind the bot cannot lay out by itself");
                return;
            }
            crafts = (wanted + expected.stackSize - 1) / expected.stackSize;
        }
        JsonArray missing = new JsonArray();
        for (Object kind : layout.distinct()) {
            int need = layout.cellsWanting(kind) * needPerCell(kind);
            int have = Layout.carried(p, kind);
            if (have < need) missing.add(layout.ingredientJson(kind, need - have));
        }
        if (missing.size() > 0) {
            JsonObject detail = new JsonObject();
            detail.add("missing", missing);
            fail("no_material", "the inventory lacks ingredients for " + crafts + " round(s) of this recipe", detail);
            return;
        }
        before = expected == null ? 0 : Inventories.count(p, outputFilter());
        if (!layout.needsTable()) {
            if (p.openContainer != p.inventoryContainer) bot.conn()
                .closeWindow();
            if (!findGrid(p.inventoryContainer)) {
                fail("internal", "the inventory has no crafting grid");
                return;
            }
            phase = "crafting";
            stage = 3;
            cell = 0;
            wait = 0;
            return;
        }
        table = tableGiven != null ? tableGiven : nearestTable(p);
        if (table == null) {
            fail(
                "invalid",
                "this recipe needs a crafting table and none is within " + TABLE_SEARCH
                    + " blocks; give the position of one");
            return;
        }
        if (!withinTravel(table[0], table[2])) return;
        phase = "going to the crafting table";
        nav.go(Goal.reach(table[0], table[1], table[2], false), Rules.NATURAL_ONLY, false);
        stage = 1;
    }

    /** A tool sits in its cell for every round; anything else is used up once per round. */
    private int needPerCell(Object kind) {
        return layout.isTool(kind) ? 1 : crafts;
    }

    private ItemFilter outputFilter() {
        return new ItemFilter(Names.itemId(expected.getItem()), Names.meta(expected), -1);
    }

    /** Finds the crafting grid and result slot of a screen. Returns false if it has none. */
    private boolean findGrid(Container c) {
        List<Slot> cells = new ArrayList<>();
        Slot result = null;
        for (Object o : c.inventorySlots) {
            Slot s = (Slot) o;
            if (s instanceof SlotCrafting && result == null) result = s;
            else if (s.inventory instanceof InventoryCrafting) cells.add(s);
        }
        int width = cells.size() == 9 ? 3 : (cells.size() == 4 ? 2 : 0);
        if (result == null || width == 0) return false;
        gridSlots = new int[cells.size()];
        for (Slot s : cells) {
            int i = s.getSlotIndex();
            if (i < 0 || i >= gridSlots.length) return false;
            gridSlots[i] = s.slotNumber;
        }
        grid = c;
        gridWidth = width;
        resultSlot = result.slotNumber;
        return true;
    }

    private boolean gridIsEmpty() {
        for (int n : gridSlots) if (grid.getSlot(n)
            .getHasStack()) return false;
        return true;
    }

    private static final String[] TABLES = { "minecraft:crafting_table", "TConstruct:CraftingStation",
        "TConstruct:CraftingSlab", "Natura:Natura.workbench" };

    private int[] nearestTable(EntityPlayerMP p) {
        Set<Block> tables = new HashSet<>();
        tables.add(Blocks.crafting_table);
        for (String id : TABLES) {
            Block b = Names.block(id);
            if (b != null) tables.add(b);
        }
        JsonObject found = WorldQueries
            .find(p.worldObj, bot.blockX(), bot.blockY(), bot.blockZ(), TABLE_SEARCH, tables, 1);
        JsonArray matches = found.getAsJsonArray("matches");
        if (matches == null || matches.size() == 0) return null;
        JsonObject m = matches.get(0)
            .getAsJsonObject();
        return new int[] { m.get("x")
            .getAsInt(),
            m.get("y")
                .getAsInt(),
            m.get("z")
                .getAsInt() };
    }

    private void layOutNextCell(EntityPlayerMP p) {
        while (cell < layout.cells.length && layout.cells[cell] == null) cell++;
        if (cell >= layout.cells.length) {
            stage = 4;
            return;
        }
        Object kind = layout.cells[cell];
        int need = needPerCell(kind);
        int col = cell % layout.width, row = cell / layout.width;
        int target = gridSlots[row * gridWidth + col];
        stowCursor(p);
        int placed = 0;
        for (Object o : grid.inventorySlots) {
            if (placed >= need) break;
            Slot s = (Slot) o;
            // The bot's own 36 slots; index 36 and up is the armour it wears.
            if (s.inventory != p.inventory || s.getSlotIndex() >= 36) continue;
            if (!Layout.matches(kind, s.getStack())) continue;
            grid.slotClick(s.slotNumber, 0, 0, p); // pick the stack up
            while (placed < need && p.inventory.getItemStack() != null) {
                int held = p.inventory.getItemStack().stackSize;
                grid.slotClick(target, 1, 0, p); // right-click: set one down
                ItemStack now = p.inventory.getItemStack();
                if (now != null && now.stackSize >= held) break; // the cell would not take it
                placed++;
            }
            if (p.inventory.getItemStack() != null) grid.slotClick(s.slotNumber, 0, 0, p); // the rest goes back
            stowCursor(p);
        }
        grid.detectAndSendChanges();
        if (placed < need) {
            failCode = "no_material";
            failMessage = "ran short of " + layout.label(kind) + " while laying the recipe out";
            JsonObject detail = new JsonObject();
            JsonArray missing = new JsonArray();
            missing.add(layout.ingredientJson(kind, need - placed));
            detail.add("missing", missing);
            failDetail = detail;
            stage = 5;
            return;
        }
        cell++;
    }

    /** Whatever is on the cursor goes back into the inventory, or onto the ground if there is no room. */
    private static void stowCursor(EntityPlayerMP p) {
        ItemStack held = p.inventory.getItemStack();
        if (held == null) return;
        p.inventory.setItemStack(null);
        if (!p.inventory.addItemStackToInventory(held) && held.stackSize > 0) {
            p.dropPlayerItemWithRandomChoice(held, false);
        }
    }

    private void takeResult(EntityPlayerMP p) {
        Slot result = grid.getSlot(resultSlot);
        ItemStack out = result.getStack();
        if (expected == null && out != null) {
            expected = out.copy();
            before = Inventories.count(p, outputFilter());
        }
        if (out == null || out.getItem() != expected.getItem() || Names.meta(out) != Names.meta(expected)) {
            failCode = "invalid";
            failMessage = "laid out as the recipe says, the grid gives "
                + (out == null ? "nothing" : Names.displayName(out))
                + (expected == null ? "" : " instead of " + Names.displayName(expected));
            return;
        }
        // Shift-click: the game repeats the craft for as long as the grid still holds the recipe.
        grid.slotClick(resultSlot, 0, 1, p);
        grid.detectAndSendChanges();
        stowCursor(p);
        made = Inventories.count(p, outputFilter()) - before;
    }

    private void emptyGrid(EntityPlayerMP p) {
        if (grid == null) return;
        boolean isTable = grid != p.inventoryContainer;
        if (isTable && p.openContainer != grid) return;
        for (int n : gridSlots) {
            Slot s = grid.getSlot(n);
            if (!s.getHasStack()) continue;
            grid.slotClick(s.slotNumber, 0, 1, p);
            if (s.getHasStack() && !isTable) {
                // No room: nothing may stay behind in the grid a player carries.
                ItemStack rest = s.getStack();
                s.putStack(null);
                p.dropPlayerItemWithRandomChoice(rest, false);
            }
        }
        grid.detectAndSendChanges();
        stowCursor(p);
        // Closing a crafting table drops whatever could not be taken back at the bot's feet.
        if (isTable) bot.conn()
            .closeWindow();
        grid = null;
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        o.addProperty("crafted", Math.max(0, made));
        if (expected != null) {
            JsonObject item = new JsonObject();
            item.addProperty("id", Names.itemId(expected.getItem()));
            item.addProperty("meta", Names.meta(expected));
            item.addProperty("name", Names.displayName(expected));
            o.add("item", item);
        }
        if (bot != null && bot.online()) o.addProperty("freeSlots", Inventories.freeSlots(bot.player()));
        return o;
    }
}
