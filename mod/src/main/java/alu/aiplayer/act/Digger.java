package alu.aiplayer.act;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.world.World;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.util.Names;

/**
 * Breaks one block the way a survival player does: pick the tool, start digging, keep swinging until the server
 * finishes the block, then pause briefly before the next one. Call {@link #tick()} every tick until it stops
 * returning WORKING.
 */
public final class Digger {

    public enum Status {
        WORKING,
        DONE,
        FAILED
    }

    /** Ticks a client waits after a block breaks before it can start on the next. */
    private static final int COOLDOWN = 5;

    private final Bot bot;
    private int x, y, z;
    private int face;
    private int phase; // 0 idle, 1 start, 2 digging, 3 cooldown
    private int ticks;
    private int limit;
    private int expected;
    private boolean finishSent;
    private boolean retried;
    private Block target;
    private int targetMeta;

    /** Why the last block failed: no_tool, out_of_reach, unbreakable or denied. */
    public String failCode;
    public String failMessage;
    public String failBlock;

    public Digger(Bot bot) {
        this.bot = bot;
    }

    public boolean busy() {
        return phase != 0;
    }

    public void begin(int x, int y, int z) {
        this.x = x;
        this.y = y;
        this.z = z;
        phase = 1;
        ticks = 0;
        retried = false;
        failCode = null;
        failMessage = null;
        failBlock = null;
    }

    public Status tick() {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        switch (phase) {
            case 1:
                return start(p, w);
            case 2: {
                Block now = w.getBlock(x, y, z);
                if (now != target || w.getBlockMetadata(x, y, z) != targetMeta || now.isAir(w, x, y, z)) {
                    phase = 3;
                    ticks = 0;
                    return Status.WORKING;
                }
                if (!Reach.canReach(p, x, y, z)) {
                    // Pushed or carried away mid-dig (a current, a fall): the server would ignore the finish.
                    abort();
                    return fail("out_of_reach", "moved out of reach while digging");
                }
                bot.motion.lookAt(p, x + 0.5, y + 0.5, z + 0.5);
                if (ticks % 5 == 0) bot.conn()
                    .swingArm();
                ticks++;
                if (ticks >= expected && !finishSent) {
                    // The moment a client's own progress bar fills up. Until then an abort cancels cleanly.
                    finishSent = true;
                    bot.conn()
                        .finishDigging(x, y, z, face);
                }
                if (ticks > limit) {
                    if (!finishSent) bot.conn()
                        .abortDigging(x, y, z, face);
                    if (!retried) {
                        // Digging speed can drop under way (tool broke, feet left the ground). Once more from
                        // the start before concluding that something forbids it.
                        retried = true;
                        phase = 1;
                        return Status.WORKING;
                    }
                    return fail("denied", "the block did not break; it may be protected");
                }
                return Status.WORKING;
            }
            case 3:
                if (++ticks >= COOLDOWN) {
                    phase = 0;
                    return Status.DONE;
                }
                return Status.WORKING;
            default:
                return Status.DONE;
        }
    }

    private Status start(EntityPlayerMP p, World w) {
        Block block = w.getBlock(x, y, z);
        if (block.isAir(w, x, y, z)) {
            phase = 0;
            return Status.DONE;
        }
        if (!Reach.canReach(p, x, y, z)) return fail("out_of_reach", "the block is out of reach");
        Tools.Choice choice = Tools.best(p, w, x, y, z);
        if (choice == null) return fail("unbreakable", "the block cannot be broken");
        if (!choice.worthwhile()) {
            return fail("no_tool", "no carried tool can harvest " + Names.blockId(block));
        }
        Tools.hold(bot, choice);
        target = block;
        targetMeta = w.getBlockMetadata(x, y, z);
        face = Reach.facingSide(p, x, y, z);
        Motion.face(p, x + 0.5, y + 0.5, z + 0.5);
        bot.conn()
            .startDigging(x, y, z, face);
        bot.conn()
            .swingArm();
        if (w.getBlock(x, y, z) != target || w.getBlock(x, y, z)
            .isAir(w, x, y, z)) {
            // Broke at once (soft blocks, fast tools): no pause needed, like a client mining instantly.
            phase = 0;
            return Status.DONE;
        }
        phase = 2;
        ticks = 0;
        finishSent = false;
        expected = Math.max(1, choice.ticks() - 1);
        limit = choice.ticks() * 2 + 60;
        return Status.WORKING;
    }

    private Status fail(String code, String message) {
        Block b = bot.player().worldObj.getBlock(x, y, z);
        failCode = code;
        failMessage = message;
        failBlock = Names.blockId(b);
        phase = 0;
        return Status.FAILED;
    }

    /** Stops digging and lets go of the block. */
    public void abort() {
        if (phase == 2 && !finishSent && bot.online()) bot.conn()
            .abortDigging(x, y, z, face);
        phase = 0;
    }
}
