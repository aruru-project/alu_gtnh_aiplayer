package alu.aiplayer.task;

import alu.aiplayer.act.ContainerSession;
import alu.aiplayer.act.Drawers;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;

/** Walks to a container and runs one session at it. */
final class ContainerTrip {

    enum Status {
        WORKING,
        DONE,
        FAILED
    }

    final ContainerSession session;
    private final Navigator nav;
    private boolean arrived;
    private boolean frontChecked;
    private final Bot bot;
    private final int x, y, z;
    String failCode;
    String failMessage;

    ContainerTrip(Bot bot, int x, int y, int z) {
        this.bot = bot;
        this.x = x;
        this.y = y;
        this.z = z;
        session = new ContainerSession(bot, x, y, z);
        nav = new Navigator(bot);
        nav.go(Goal.reach(x, y, z, false), Rules.NATURAL_ONLY, false);
    }

    Status tick() {
        if (!arrived) {
            Navigator.Status st = nav.tick();
            if (st == Navigator.Status.WORKING) return Status.WORKING;
            if (st == Navigator.Status.FAILED) {
                failCode = nav.failCode;
                failMessage = "cannot get to the container: " + nav.failMessage;
                return Status.FAILED;
            }
            arrived = true;
            if (!frontChecked) {
                // Drawers are only used from the front; being within reach behind one is not enough.
                frontChecked = true;
                net.minecraft.tileentity.TileEntity te = bot.player().worldObj.getTileEntity(x, y, z);
                if (Drawers.is(te) && !Drawers.inFront(bot.player(), x, y, z, Drawers.front(te))) {
                    nav.go(Goal.reachFacing(x, y, z, Drawers.front(te)), Rules.NATURAL_ONLY, false);
                    arrived = false;
                    return Status.WORKING;
                }
            }
        }
        ContainerSession.Status st = session.tick();
        if (st == ContainerSession.Status.WORKING) return Status.WORKING;
        if (st == ContainerSession.Status.FAILED) {
            failCode = "out_of_reach".equals(session.failCode) ? "unreachable" : session.failCode;
            failMessage = session.failMessage;
            return Status.FAILED;
        }
        return Status.DONE;
    }

    void stop() {
        nav.stop();
        session.abort();
    }
}
