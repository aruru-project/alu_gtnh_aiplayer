package alu.aiplayer.act;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Set;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.inventory.IInventory;
import net.minecraft.inventory.ISidedInventory;
import net.minecraft.inventory.Slot;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;

/**
 * One visit to a container the bot is standing next to: open it, move stacks in or out one at a time, close it.
 * <p>
 * The normal way is the container's own screen, driven with the same shift-clicks a player uses, so the block's
 * rules about what goes where apply. Drawers have no screen and are worked the way a player works them: punched
 * to take, right-clicked with the item in hand to fill. Other storage without a screen (barrels) is filled and
 * emptied through its item-handling interface, the way a hopper would. So are GregTech's processing machines once
 * their screen has opened for the bot: what goes in lands in the input slots and what is taken comes from the
 * output slots, as it would by hand, since their screens are not built from the slots this code can click.
 */
public final class ContainerSession {

    public enum Status {
        WORKING,
        DONE,
        FAILED
    }

    /** Which of the bot's stacks to put in, and how many items at most (-1 for all). */
    public interface DepositPlan {

        /** How many items of this stack should go in: 0 to keep it, -1 for the whole stack. */
        int wanted(ItemStack stack);

        void moved(ItemStack type, int count);
    }

    private static final int CLICK_INTERVAL = 3;
    private static final int OPEN_WAIT = 4;
    /** Two right-clicks on a drawer within ten ticks count as a double click, which empties the whole inventory
     * of that kind into it. */
    private static final int DRAWER_PUT_INTERVAL = 12;

    private final Bot bot;
    private final int x, y, z;
    private DepositPlan deposit;
    private List<ItemFilter> withdraw;
    private int[] withdrawLeft;
    private int phase; // 0 open, 1 wait for screen, 2 screen transfers, 3 direct transfers, 4 closing, 5 drawers
    private int interval = CLICK_INTERVAL;
    private final Set<ItemStack> unplaceable = Collections.newSetFromMap(new IdentityHashMap<ItemStack, Boolean>());
    private final Set<Integer> deadDrawers = new HashSet<>();
    /** For a processing machine, its input and output slots as {first, count}. */
    private int[] machineIn, machineOut;
    private boolean fromInputs;
    private int wait;
    private int cursor;
    private boolean viaScreen;
    private int rejected;
    private boolean takeAll;

    public int moved;
    /** True when some of what was to be deposited did not fit. */
    public boolean containerFull;
    /** True when a withdrawal stopped because the bot's inventory is full. */
    public boolean inventoryFull;
    public String failCode;
    public String failMessage;

    /** When set, the screen is the one a carried item opens when used (a backpack), not a block's. */
    private final ItemFilter opener;
    private int openerSlot = -1;

    public ContainerSession(Bot bot, int x, int y, int z) {
        this.bot = bot;
        this.x = x;
        this.y = y;
        this.z = z;
        this.opener = null;
    }

    /** A session at the screen that opens when the bot uses an item it carries: a backpack and its like. */
    public ContainerSession(Bot bot, ItemFilter opener) {
        this.bot = bot;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.opener = opener;
    }

    public ContainerSession deposit(DepositPlan plan) {
        this.deposit = plan;
        return this;
    }

    public ContainerSession withdraw(List<ItemFilter> items) {
        this.withdraw = items;
        this.withdrawLeft = new int[items.size()];
        for (int i = 0; i < items.size(); i++) {
            withdrawLeft[i] = items.get(i).count < 0 ? Integer.MAX_VALUE : items.get(i).count;
        }
        return this;
    }

    /** Takes everything the container holds, as far as the bot can carry it. */
    public ContainerSession withdrawAll() {
        this.withdraw = new ArrayList<>();
        this.withdrawLeft = new int[] { Integer.MAX_VALUE };
        this.takeAll = true;
        return this;
    }

    /** Items of each withdraw filter still not obtained (0 when satisfied or when everything available was taken). */
    public int withdrawMissing(int index) {
        return withdrawLeft[index] == Integer.MAX_VALUE ? 0 : withdrawLeft[index];
    }

    /** At a processing machine, take from the input slots instead of the output slots: getting back what was put in. */
    public ContainerSession fromInputSlots() {
        fromInputs = true;
        return this;
    }

    public boolean usedScreen() {
        return viaScreen;
    }

    public Status tick() {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        if (opener != null && phase <= 1) return openByItem(p);
        switch (phase) {
            case 0: {
                if (!w.blockExists(x, y, z)) return fail("out_of_reach", "the container is out of reach");
                TileEntity te = w.getTileEntity(x, y, z);
                if (!(te instanceof IInventory)) return fail("invalid", "there is no container at that position");
                if (!Reach.canReach(p, x, y, z)) return fail("out_of_reach", "the container is out of reach");
                // Some other screen left open would be mistaken for this container's.
                if (p.openContainer != p.inventoryContainer) bot.conn()
                    .closeWindow();
                if (Drawers.is(te)) {
                    if (!Drawers.inFront(p, x, y, z, Drawers.front(te))) {
                        return fail("out_of_reach", "the front of the drawer cannot be reached from here");
                    }
                    if (Drawers.isSealed(te)) return fail("denied", "the drawer is sealed");
                    phase = 5;
                    wait = interval;
                    return Status.WORKING;
                }
                Motion.face(p, x + 0.5, y + 0.5, z + 0.5);
                clickEmptyHanded(p);
                phase = 1;
                wait = 0;
                return Status.WORKING;
            }
            case 1:
                if (bot.clickWasRefused(x, y, z)) {
                    return fail("denied", "opening the container was refused; it may be protected");
                }
                if (p.openContainer != p.inventoryContainer) {
                    TileEntity te = w.getTileEntity(x, y, z);
                    machineIn = Machines.inputSlots(te);
                    machineOut = Machines.outputSlots(te);
                    if (machineIn != null && machineOut != null || !hasOwnSlots(p)) {
                        // The screen opened, so the bot may use this; but it is not one that can be clicked through.
                        bot.conn()
                            .closeWindow();
                        if (!(te instanceof IInventory)) return fail("invalid", "there is no container at that position");
                        phase = 3;
                    } else {
                        viaScreen = true;
                        phase = 2;
                    }
                    wait = 0;
                    cursor = 0;
                } else if (++wait >= OPEN_WAIT) {
                    // No screen opened although nothing refused the click: storage without one (barrels, drawers).
                    TileEntity te = w.getTileEntity(x, y, z);
                    if (!(te instanceof IInventory) || !((IInventory) te).isUseableByPlayer(p)) {
                        return fail("denied", "the container cannot be used from here");
                    }
                    phase = 3;
                    wait = 0;
                    cursor = 0;
                }
                return Status.WORKING;
            case 2:
                if (p.openContainer == p.inventoryContainer) {
                    return fail("denied", "the container closed while it was being used");
                }
                if (++wait < CLICK_INTERVAL) return Status.WORKING;
                wait = 0;
                if (!screenStep(p)) {
                    bot.conn()
                        .closeWindow();
                    phase = 4;
                }
                return Status.WORKING;
            case 3: {
                TileEntity te = w.getTileEntity(x, y, z);
                if (!(te instanceof IInventory)) return fail("invalid", "the container is gone");
                if (++wait < CLICK_INTERVAL) return Status.WORKING;
                wait = 0;
                if (!directStep(p, (IInventory) te)) phase = 4;
                return Status.WORKING;
            }
            case 5: {
                TileEntity te = w.getTileEntity(x, y, z);
                if (!Drawers.is(te)) return fail("invalid", "the container is gone");
                if (bot.clickWasRefused(x, y, z) || bot.punchWasRefused(x, y, z)) {
                    return fail("denied", "using the drawer was refused; it may be protected");
                }
                if (++wait < interval) return Status.WORKING;
                wait = 0;
                if (!drawerStep(p, te)) phase = 4;
                return Status.WORKING;
            }
            default:
                if (++wait >= 2) return Status.DONE;
                return Status.WORKING;
        }
    }

    // ---- drawers ------------------------------------------------------------------------------------------------

    /** Does one click on the drawer block. Returns false when there is nothing left to do. */
    private boolean drawerStep(EntityPlayerMP p, TileEntity te) {
        List<Drawers.Slot> slots = Drawers.slots(te);
        int front = Drawers.front(te);
        if (deposit != null) {
            ItemStack[] mine = p.inventory.mainInventory;
            for (int i = 0; i < mine.length; i++) {
                ItemStack stack = mine[i];
                if (stack == null || unplaceable.contains(stack)) continue;
                int want = deposit.wanted(stack);
                if (want == 0) continue;
                // A drawer already holding this kind comes first; an unassigned one only when none does.
                Drawers.Slot target = null;
                for (Drawers.Slot s : slots) {
                    if (s.prototype != null && s.room > 0 && sameItem(s.prototype, stack)) {
                        target = s;
                        break;
                    }
                }
                if (target == null) {
                    for (Drawers.Slot s : slots) {
                        if (s.prototype == null && Drawers.accepts(te, s.index, stack)) {
                            target = s;
                            break;
                        }
                    }
                }
                float[] hit = target == null ? null : Drawers.hit(te, target.index);
                if (hit == null) {
                    unplaceable.add(stack);
                    rejected++;
                    continue;
                }
                // The click puts in the whole held stack, so the part to keep is set aside first.
                if (want > 0 && want < stack.stackSize) splitOff(p, i, stack.stackSize - want);
                ItemStack type = stack.copy();
                int offered = stack.stackSize;
                int before = Inventories.count(p, exact(type));
                Inventories.hold(bot, i);
                Motion.face(p, x + hit[0], y + hit[1], z + hit[2]);
                bot.conn()
                    .useOnBlock(x, y, z, front, hit[0], hit[1], hit[2]);
                bot.conn()
                    .swingArm();
                int gone = before - Inventories.count(p, exact(type));
                if (gone > 0) {
                    moved += gone;
                    deposit.moved(type, gone);
                }
                if (gone < offered) {
                    rejected++;
                    ItemStack left = p.inventory.getCurrentItem();
                    if (left != null) unplaceable.add(left);
                }
                interval = DRAWER_PUT_INTERVAL;
                return true;
            }
            deposit = null;
            containerFull = rejected > 0;
        }
        if (withdraw != null && !inventoryFull) {
            for (Drawers.Slot s : slots) {
                if (s.prototype == null || s.count <= 0 || deadDrawers.contains(s.index)) continue;
                int f = matchingFilter(s.prototype);
                if (f < 0) continue;
                int room = roomFor(p, s.prototype);
                if (room <= 0) {
                    inventoryFull = true;
                    break;
                }
                float[] hit = Drawers.hit(te, s.index);
                if (hit == null) {
                    deadDrawers.add(s.index);
                    continue;
                }
                // A punch gives a whole stack or a single item, nothing in between.
                int stack = Math.min(s.prototype.getMaxStackSize(), s.count);
                boolean whole = Math.min(withdrawLeft[f], room) >= stack;
                ItemFilter kind = exact(s.prototype);
                int had = Inventories.count(p, kind);
                Motion.face(p, x + hit[0], y + hit[1], z + hit[2]);
                Drawers.punch(te, p, hit, whole);
                bot.conn()
                    .swingArm();
                int got = Inventories.count(p, kind) - had;
                interval = CLICK_INTERVAL;
                if (got <= 0) {
                    // Locked, protected, or otherwise not giving: leave this drawer be.
                    deadDrawers.add(s.index);
                    return true;
                }
                moved += got;
                if (withdrawLeft[f] != Integer.MAX_VALUE) withdrawLeft[f] = Math.max(0, withdrawLeft[f] - got);
                return true;
            }
            withdraw = null;
        }
        return deposit != null;
    }

    /**
     * Right-clicks the container as if nothing were held. What is in hand is set aside for the duration of the
     * click and put straight back, so a held block is not placed and a held tool does not act on the container,
     * and it works with a full inventory too.
     */
    private void clickEmptyHanded(EntityPlayerMP p) {
        clickEmptyHanded(bot, x, y, z);
    }

    /** Takes the item in hand and uses it, as a player right-clicks a backpack, then waits for its screen. */
    private Status openByItem(EntityPlayerMP p) {
        if (phase == 0) {
            if (p.openContainer != p.inventoryContainer) bot.conn()
                .closeWindow();
            int slot = -1;
            for (int i = 0; i < Inventories.CARRY_SLOTS && slot < 0; i++) {
                ItemStack s = p.inventory.mainInventory[i];
                if (s != null && opener.matches(s)) slot = i;
            }
            if (slot < 0) return fail("no_material", "the bot carries no such item to open");
            Inventories.hold(bot, slot);
            openerSlot = p.inventory.currentItem;
            bot.conn()
                .useItem();
            phase = 1;
            wait = 0;
            return Status.WORKING;
        }
        if (p.openContainer != p.inventoryContainer) {
            if (!hasOwnSlots(p)) {
                bot.conn()
                    .closeWindow();
                return fail("invalid", "the screen that item opens is not one whose slots can be used");
            }
            viaScreen = true;
            phase = 2;
            wait = 0;
            cursor = 0;
        } else if (++wait >= OPEN_WAIT) {
            return fail("invalid", "using that item opened no screen; it may be something to place or to wear instead");
        }
        return Status.WORKING;
    }

    /** Right-clicks a block as if nothing were held; see the instance method. */
    public static void clickEmptyHanded(Bot bot, int x, int y, int z) {
        EntityPlayerMP p = bot.player();
        int slot = p.inventory.currentItem;
        ItemStack held = p.inventory.mainInventory[slot];
        p.inventory.mainInventory[slot] = null;
        try {
            int side = Reach.facingSide(p, x, y, z);
            bot.conn()
                .useOnBlock(x, y, z, side, 0.5F, 0.5F, 0.5F);
        } finally {
            if (p.inventory.mainInventory[slot] == null) {
                p.inventory.mainInventory[slot] = held;
            } else if (held != null && !p.inventory.addItemStackToInventory(held)) {
                // Something appeared in the hand during the click and there is no room: drop rather than lose it.
                p.dropPlayerItemWithRandomChoice(held, false);
            }
        }
        bot.conn()
            .swingArm();
    }

    /** Whether the open screen shows the bot's own inventory in slots of the ordinary kind. */
    private static boolean hasOwnSlots(EntityPlayerMP p) {
        for (Object o : p.openContainer.inventorySlots) if (((Slot) o).inventory == p.inventory) return true;
        return false;
    }

    public void abort() {
        if (bot.online() && bot.player().openContainer != bot.player().inventoryContainer) bot.conn()
            .closeWindow();
    }

    private Status fail(String code, String message) {
        failCode = code;
        failMessage = message;
        abort();
        return Status.FAILED;
    }

    // ---- through the container's screen -----------------------------------------------------------------------

    /** Does one transfer. Returns false when there is nothing left to do. */
    private boolean screenStep(EntityPlayerMP p) {
        Container c = p.openContainer;
        List<Slot> mine = new ArrayList<>();
        List<Slot> theirs = new ArrayList<>();
        for (Object o : c.inventorySlots) {
            Slot s = (Slot) o;
            if (s.inventory == p.inventory) mine.add(s);
            else theirs.add(s);
        }
        if (deposit != null) {
            for (; cursor < mine.size(); cursor++) {
                Slot s = mine.get(cursor);
                ItemStack stack = s.getStack();
                if (stack == null) continue;
                // The bag in the hand does not go into itself.
                if (opener != null && s.getSlotIndex() == openerSlot) continue;
                int want = deposit.wanted(stack);
                if (want == 0) continue;
                if (want > 0 && want < stack.stackSize) {
                    // Set the surplus aside in a free slot first, so the shift-click moves exactly the wanted part.
                    if (!splitOff(p, s.getSlotIndex(), stack.stackSize - want)) want = stack.stackSize;
                    stack = s.getStack();
                }
                ItemStack type = stack.copy();
                int offered = stack.stackSize;
                // Counted across the whole inventory: some screens answer a shift-click by shuffling the stack
                // to another of the bot's own slots, which is not a deposit.
                int before = Inventories.count(p, exact(type));
                c.slotClick(s.slotNumber, 0, 1, p);
                c.detectAndSendChanges();
                int gone = before - Inventories.count(p, exact(type));
                if (gone > 0) {
                    moved += gone;
                    deposit.moved(type, gone);
                }
                // What stays behind did not fit. Other kinds of item might still, so carry on.
                if (gone < offered) rejected++;
                cursor++;
                return true;
            }
            deposit = null;
            cursor = 0;
            containerFull = rejected > 0;
        }
        if (withdraw != null && !inventoryFull) {
            for (; cursor < theirs.size(); cursor++) {
                Slot s = theirs.get(cursor);
                ItemStack stack = s.getStack();
                if (stack == null || !s.canTakeStack(p)) continue;
                int f = matchingFilter(stack);
                if (f < 0) continue;
                ItemStack type = stack.copy();
                int had = Inventories.count(p, exact(type));
                c.slotClick(s.slotNumber, 0, 1, p);
                c.detectAndSendChanges();
                int got = Inventories.count(p, exact(type)) - had;
                if (got <= 0) {
                    inventoryFull = Inventories.freeSlots(p) == 0;
                    if (inventoryFull) break;
                    continue;
                }
                moved += got;
                if (withdrawLeft[f] != Integer.MAX_VALUE) {
                    withdrawLeft[f] -= got;
                    if (withdrawLeft[f] < 0) {
                        // Took a whole stack where less was asked for; hand the surplus back next.
                        final int surplus = -withdrawLeft[f];
                        withdrawLeft[f] = 0;
                        returnSurplus(type, surplus);
                    }
                }
                return true;
            }
            withdraw = null;
        }
        return deposit != null;
    }

    /** After an over-large withdrawal, queue a deposit of exactly the surplus. */
    private void returnSurplus(final ItemStack type, final int surplus) {
        deposit = new DepositPlan() {

            int left = surplus;

            @Override
            public int wanted(ItemStack stack) {
                if (left <= 0 || !sameItem(stack, type)) return 0;
                return Math.min(left, stack.stackSize);
            }

            @Override
            public void moved(ItemStack t, int count) {
                left -= count;
                moved -= 2 * count; // it was counted coming out and again going back
            }
        };
        cursor = 0;
    }

    private static boolean splitOff(EntityPlayerMP p, int invSlot, int count) {
        ItemStack[] inv = p.inventory.mainInventory;
        if (invSlot < 0 || invSlot >= inv.length || inv[invSlot] == null) return false;
        for (int i = 9; i < inv.length && i < Inventories.CARRY_SLOTS; i++) {
            if (inv[i] == null) {
                inv[i] = inv[invSlot].splitStack(count);
                p.inventory.markDirty();
                return true;
            }
        }
        return false;
    }

    private int matchingFilter(ItemStack stack) {
        if (withdraw.isEmpty()) return takeAll ? 0 : -1;
        for (int i = 0; i < withdraw.size(); i++) {
            if (withdrawLeft[i] > 0 && withdraw.get(i)
                .matches(stack)) return i;
        }
        return -1;
    }

    private static ItemFilter exact(ItemStack type) {
        return new ItemFilter(alu.aiplayer.util.Names.itemId(type.getItem()), alu.aiplayer.util.Names.meta(type), -1);
    }

    private static boolean sameItem(ItemStack a, ItemStack b) {
        return a != null && b != null
            && a.getItem() == b.getItem()
            && alu.aiplayer.util.Names.meta(a) == alu.aiplayer.util.Names.meta(b)
            && ItemStack.areItemStackTagsEqual(a, b);
    }

    // ---- through the item-handling interface ------------------------------------------------------------------

    private boolean directStep(EntityPlayerMP p, IInventory inv) {
        ItemStack[] mine = p.inventory.mainInventory;
        if (deposit != null) {
            for (; cursor < mine.length; cursor++) {
                ItemStack stack = mine[cursor];
                if (stack == null) continue;
                int want = deposit.wanted(stack);
                if (want == 0) continue;
                if (want < 0 || want > stack.stackSize) want = stack.stackSize;
                ItemStack type = stack.copy();
                int put = insert(inv, stack, want);
                if (put < want) rejected++;
                if (stack.stackSize <= 0) mine[cursor] = null;
                if (put > 0) {
                    moved += put;
                    deposit.moved(type, put);
                    inv.markDirty();
                    p.inventory.markDirty();
                }
                cursor++;
                return true;
            }
            deposit = null;
            cursor = 0;
            containerFull = rejected > 0;
        }
        if (withdraw != null && !inventoryFull) {
            int[] slots = slotsFor(inv, false);
            for (; cursor < slots.length; cursor++) {
                int slot = slots[cursor];
                ItemStack stack = inv.getStackInSlot(slot);
                if (stack == null) continue;
                int f = matchingFilter(stack);
                if (f < 0) continue;
                if (machineIn == null && inv instanceof ISidedInventory
                    && !((ISidedInventory) inv).canExtractItem(slot, stack, 1)) continue;
                int room = roomFor(p, stack);
                if (room <= 0) {
                    inventoryFull = true;
                    break;
                }
                int take = Math.min(room, Math.min(stack.stackSize, withdrawLeft[f]));
                ItemStack out = inv.decrStackSize(slot, take);
                if (out == null) continue;
                int got = out.stackSize;
                if (!p.inventory.addItemStackToInventory(out) && out.stackSize > 0) {
                    // Should not happen after the room check; never let the remainder vanish.
                    got -= out.stackSize;
                    p.dropPlayerItemWithRandomChoice(out, false);
                }
                inv.markDirty();
                p.inventory.markDirty();
                if (got > 0) {
                    moved += got;
                    if (withdrawLeft[f] != Integer.MAX_VALUE) withdrawLeft[f] -= got;
                }
                cursor++;
                return true;
            }
            withdraw = null;
        }
        return deposit != null;
    }

    /** How many more items like this the bot's inventory can take. */
    private static int roomFor(EntityPlayerMP p, ItemStack like) {
        int room = 0;
        int max = like.getMaxStackSize();
        ItemStack[] inv = p.inventory.mainInventory;
        for (int i = 0; i < inv.length && i < Inventories.CARRY_SLOTS; i++) {
            ItemStack s = inv[i];
            if (s == null) room += max;
            else if (sameItem(s, like) && s.isStackable()) room += Math.max(0, max - s.stackSize);
        }
        return room;
    }

    private int[] slotsFor(IInventory inv, boolean putting) {
        if (machineIn == null || machineOut == null) return accessible(inv);
        int[] range = putting || fromInputs ? machineIn : machineOut;
        int[] out = new int[Math.max(0, Math.min(range[1], inv.getSizeInventory() - range[0]))];
        for (int i = 0; i < out.length; i++) out[i] = range[0] + i;
        return out;
    }

    private static int[] accessible(IInventory inv) {
        if (inv instanceof ISidedInventory) {
            int[] slots = ((ISidedInventory) inv).getAccessibleSlotsFromSide(1);
            if (slots != null) return slots;
        }
        int[] all = new int[inv.getSizeInventory()];
        for (int i = 0; i < all.length; i++) all[i] = i;
        return all;
    }

    /** Moves up to {@code count} items of a stack into the inventory, hopper-style. Returns how many went in. */
    private int insert(IInventory inv, ItemStack stack, int count) {
        int left = count;
        int[] slots = slotsFor(inv, true);
        boolean machine = machineIn != null;
        int limit = inv.getInventoryStackLimit();
        // Top up matching stacks before opening new slots.
        for (int pass = 0; pass < 2 && left > 0; pass++) {
            for (int slot : slots) {
                if (left <= 0) break;
                ItemStack there = inv.getStackInSlot(slot);
                if (pass == 0 ? there == null : there != null) continue;
                // A machine's sides matter to pipes and hoppers, not to a hand reaching into its screen.
                if (!machine && !inv.isItemValidForSlot(slot, stack)) continue;
                if (!machine && inv instanceof ISidedInventory
                    && !((ISidedInventory) inv).canInsertItem(slot, stack, 1)) continue;
                if (there == null) {
                    int n = Math.min(left, Math.min(limit, stack.getMaxStackSize()));
                    inv.setInventorySlotContents(slot, stack.splitStack(n));
                    left -= n;
                } else if (sameItem(there, stack)) {
                    int room = Math.min(limit, there.getMaxStackSize()) - there.stackSize;
                    int n = Math.min(left, room);
                    if (n > 0) {
                        there.stackSize += n;
                        stack.stackSize -= n;
                        left -= n;
                    }
                }
            }
        }
        return count - left;
    }
}
