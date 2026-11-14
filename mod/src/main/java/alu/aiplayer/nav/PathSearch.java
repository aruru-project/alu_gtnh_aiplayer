package alu.aiplayer.nav;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * A* over feet cells, resumable so one search can be spread over several ticks.
 * <p>
 * Moves: walk to a neighbour on the same level, step or jump up one, walk off an edge and drop up to three, build a
 * one-block pillar under the feet, dig straight down one, climb up or down a ladder (and step off it onto a floor
 * beside it, or from a floor onto it). Any of them may first break blocks that are in the way when the
 * {@link NavWorld} allows it. Each step records only where it goes and how; the follower works out at the
 * time what has to be cleared, since the world may have changed.
 */
public final class PathSearch {

    public enum Status {
        RUNNING,
        /** A path to the goal. */
        FOUND,
        /** The goal was not reached within the node limit; the path leads as close as the search got. */
        PARTIAL,
        /** No way to get closer. */
        NONE
    }

    public static final byte TRAVERSE = 1;
    public static final byte ASCEND = 2;
    public static final byte DESCEND = 3;
    public static final byte PILLAR = 4;
    public static final byte DIG_DOWN = 5;
    /** Ride an elevator block to another one above or below. */
    public static final byte ELEVATOR = 6;
    /** Climb one cell up a ladder, pushing toward the wall it hangs on. */
    public static final byte CLIMB_UP = 7;
    /** Let go and slide down a ladder, to the next cell of it or to the ground under it. */
    public static final byte CLIMB_DOWN = 8;
    /** In a liquid column: hold jump to rise, release it to sink. */
    public static final byte SWIM = 9;

    public static final class Step {

        public final int x, y, z;
        public final byte move;

        Step(int x, int y, int z, byte move) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.move = move;
        }
    }

    private static final double WALK = Goal.WALK;
    private static final double JUMP = 4.0;
    private static final double FALL_PER_BLOCK = 2.0;
    private static final double WATER_FACTOR = 2.5;
    private static final double PILLAR_COST = 22.0;
    private static final int DOOR_COST = 12;
    private static final double ELEVATOR_COST = 14.0;
    /** Ticks per block: a player pushing into a ladder rises about 0.12 a tick, and slides down at 0.15. */
    private static final double LADDER_UP_COST = 8.5;
    private static final double LADDER_DOWN_COST = 7.0;
    private static final double HEURISTIC_WEIGHT = 1.3;
    /** How far a bot that can be hurt will let itself fall. */
    public static final int SAFE_DROP = 3;
    /** How far one that cannot be hurt will: off a roof, not down a ravine. */
    public static final int FEARLESS_DROP = 40;
    private static final int[][] DIRS = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } };

    private static final class Node {

        final int x, y, z;
        double g, f, h;
        Node parent;
        byte move;
        boolean closed;

        Node(int x, int y, int z) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
    }

    /** A queue entry is a snapshot: when a node gets a better cost it is queued again and the old entry goes stale. */
    private static final class Entry implements Comparable<Entry> {

        final Node node;
        final double f;

        Entry(Node node) {
            this.node = node;
            this.f = node.f;
        }

        @Override
        public int compareTo(Entry o) {
            return Double.compare(f, o.f);
        }
    }

    private final NavWorld nav;
    private final Goal goal;
    private final boolean canPillar;
    private final int maxNodes;
    private final int maxDrop;
    private final boolean swim;
    private final Map<Long, Node> nodes = new HashMap<>();
    private final PriorityQueue<Entry> open = new PriorityQueue<>();
    private final Node start;
    private Node best;
    private int expanded;
    private Status status = Status.RUNNING;
    private List<Step> path = Collections.emptyList();
    private double progress;

    public PathSearch(NavWorld nav, int sx, int sy, int sz, Goal goal, boolean canPillar, int maxNodes,
        int maxDrop) {
        this(nav, sx, sy, sz, goal, canPillar, maxNodes, maxDrop, false);
    }

    public PathSearch(NavWorld nav, int sx, int sy, int sz, Goal goal, boolean canPillar, int maxNodes,
        int maxDrop, boolean swim) {
        this.swim = swim;
        this.maxDrop = maxDrop;
        this.nav = nav;
        this.goal = goal;
        this.canPillar = canPillar;
        this.maxNodes = maxNodes;
        start = new Node(sx, sy, sz);
        start.h = goal.heuristic(sx, sy, sz);
        start.f = start.h * HEURISTIC_WEIGHT;
        nodes.put(NavWorld.key(sx, sy, sz), start);
        open.add(new Entry(start));
        best = start;
    }

    public Status status() {
        return status;
    }

    public List<Step> path() {
        return path;
    }

    public int expanded() {
        return expanded;
    }

    /** How much nearer the goal the path's end is than its start, by the goal's own estimate. */
    public double progress() {
        return progress;
    }

    /** Works for about the given time, then returns the status so far. */
    public Status step(long budgetNanos) {
        if (status != Status.RUNNING) return status;
        long deadline = System.nanoTime() + budgetNanos;
        int sinceCheck = 0;
        while (true) {
            Entry e = open.poll();
            Node n = e == null ? null : e.node;
            if (n == null) {
                // Everything reachable has been seen. Heading for the closest point only helps if part of the
                // world was unloaded and may open up on the way.
                if (best != start && nav.sawUnloaded) return finish(best, Status.PARTIAL);
                return finish(null, Status.NONE);
            }
            if (n.closed || e.f > n.f) continue;
            n.closed = true;
            // A cell where the bot only hangs on a ladder is no place to stop.
            if (goal.reached(n.x, n.y, n.z) && stand(n.x, n.y, n.z) != HANGING) return finish(n, Status.FOUND);
            if (n.h < best.h) best = n;
            if (++expanded >= maxNodes) {
                return best != start && best.h < start.h - 0.5 ? finish(best, Status.PARTIAL)
                    : finish(null, Status.NONE);
            }
            expand(n);
            if (++sinceCheck >= 16) {
                sinceCheck = 0;
                if (System.nanoTime() > deadline) return Status.RUNNING;
            }
        }
    }

    private Status finish(Node end, Status result) {
        status = result;
        if (end != null) {
            progress = start.h - end.h;
            List<Step> steps = new ArrayList<>();
            for (Node n = end; n != null && n.parent != null; n = n.parent) steps.add(new Step(n.x, n.y, n.z, n.move));
            Collections.reverse(steps);
            path = steps;
        }
        open.clear();
        nodes.clear();
        return status;
    }

    // ---- world model ----------------------------------------------------------------------------------------

    /** Feet in a ladder cell with nothing under them: holding on, not standing. */
    private static final int HANGING = 4;

    /**
     * 0 cannot stand, 1 on a full block (or at the foot of a ladder), 2 on a half block, 3 in water (surface only
     * unless swimming was requested), 4 hanging on a ladder.
     */
    private int stand(int x, int y, int z) {
        byte feet = nav.cls(x, y, z);
        byte head = nav.cls(x, y + 1, z);
        if (feet == NavWorld.SLAB) {
            return passable(head) && nav.passable(x, y + 2, z) && !nav.nearHazard(x, y, z) ? 2 : 0;
        }
        if (feet == NavWorld.WATER) {
            return (head == NavWorld.OPEN || (swim && head == NavWorld.WATER)) && !nav.nearHazard(x, y, z) ? 3 : 0;
        }
        if (feet == NavWorld.CLIMB) {
            if (!passable(head) || nav.nearHazard(x, y, z)) return 0;
            return nav.cls(x, y - 1, z) == NavWorld.SOLID ? 1 : HANGING;
        }
        if (feet != NavWorld.OPEN || !passable(head)) return 0;
        if (nav.cls(x, y - 1, z) != NavWorld.SOLID) return 0;
        return nav.nearHazard(x, y, z) ? 0 : 1;
    }

    private static boolean openOrWater(byte c) {
        return c == NavWorld.OPEN || c == NavWorld.WATER;
    }

    private static boolean passable(byte c) {
        return c == NavWorld.OPEN || c == NavWorld.WATER || c == NavWorld.CLIMB;
    }

    /** Cost to have a cell open: 0 if it is, the digging time if it may be broken, -1 if it cannot be. */
    private int openCost(int x, int y, int z) {
        byte c = nav.cls(x, y, z);
        if (c == NavWorld.OPEN || c == NavWorld.WATER || c == NavWorld.CLIMB) return 0;
        if (c == NavWorld.HAZARD || c == NavWorld.UNLOADED) return -1;
        if (c == NavWorld.DOOR) return DOOR_COST;
        return nav.breakCost(x, y, z);
    }

    private void expand(Node n) {
        int x = n.x, y = n.y, z = n.z;
        int here = n == start ? Math.max(1, stand(x, y, z)) : stand(x, y, z);
        if (here == 0) here = 1; // reached by breaking into a cell whose floor is solid
        boolean inWater = here == 3;

        for (int[] d : DIRS) {
            int nx = x + d[0], nz = z + d[1];

            // Same level.
            int s = stand(nx, y, nz);
            if (s != 0) {
                relax(n, nx, y, nz, TRAVERSE, WALK * (s == 3 || inWater ? WATER_FACTOR : 1.0));
            } else if (nav.cls(nx, y - 1, nz) == NavWorld.SOLID && !nav.nearHazard(nx, y, nz)) {
                int c1 = openCost(nx, y, nz), c2 = openCost(nx, y + 1, nz);
                if (c1 >= 0 && c2 >= 0 && c1 + c2 > 0) relax(n, nx, y, nz, TRAVERSE, WALK + c1 + c2);
            }

            // Up one. From a full block onto a half block a level higher is a 1.5 rise, too much for one jump.
            int headroom = openCost(x, y + 2, z);
            if (headroom >= 0) {
                int up = stand(nx, y + 1, nz);
                if (up == 1 || (up == 2 && here == 2)) {
                    relax(n, nx, y + 1, nz, ASCEND, WALK + JUMP + headroom);
                } else if (up == 0 && nav.cls(nx, y, nz) == NavWorld.SOLID && !nav.nearHazard(nx, y + 1, nz)) {
                    int c1 = openCost(nx, y + 1, nz), c2 = openCost(nx, y + 2, nz);
                    if (c1 >= 0 && c2 >= 0 && c1 + c2 > 0) {
                        relax(n, nx, y + 1, nz, ASCEND, WALK + JUMP + headroom + c1 + c2);
                    }
                }
            }

            // Off the edge and down: onto the ground, or onto a ladder below, which catches the bot.
            if (s == 0 && nav.cls(nx, y - 1, nz) != NavWorld.SOLID) {
                int c1 = openCost(nx, y, nz), c2 = openCost(nx, y + 1, nz);
                if (c1 >= 0 && c2 >= 0) {
                    for (int k = 1; k <= maxDrop; k++) {
                        byte below = nav.cls(nx, y - k, nz);
                        if (below == NavWorld.CLIMB) {
                            if (stand(nx, y - k, nz) != 0) {
                                relax(n, nx, y - k, nz, DESCEND, WALK + FALL_PER_BLOCK * k + c1 + c2);
                            }
                            break;
                        }
                        if (!openOrWater(below)) break;
                        int land = stand(nx, y - k, nz);
                        if (land != 0) {
                            relax(n, nx, y - k, nz, DESCEND, WALK + FALL_PER_BLOCK * k + c1 + c2);
                            break;
                        }
                    }
                }
            }
        }

        // Underwater pickups need real water-column edges, not a tunnel under the lake bed.
        if (swim && nav.cls(x, y, z) == NavWorld.WATER) {
            if (nav.cls(x, y + 1, z) == NavWorld.WATER && stand(x, y + 1, z) == 3) {
                relax(n, x, y + 1, z, SWIM, WALK * WATER_FACTOR);
            }
            if (nav.cls(x, y - 1, z) == NavWorld.WATER && stand(x, y - 1, z) == 3) {
                relax(n, x, y - 1, z, SWIM, WALK * WATER_FACTOR);
            }
        }

        // Up a ladder: from the foot of it or from a cell of it, into the cell of it above. A ladder that starts at
        // head height is reached with a jump.
        if (stand(x, y + 1, z) == HANGING) {
            byte feet = nav.cls(x, y, z);
            if (feet == NavWorld.CLIMB) relax(n, x, y + 1, z, CLIMB_UP, LADDER_UP_COST);
            else if (here == 1 && feet == NavWorld.OPEN) relax(n, x, y + 1, z, CLIMB_UP, LADDER_UP_COST + JUMP);
        }
        // Down a ladder: let go and slide, to the next cell of it or to the ground under it.
        if (here == HANGING) {
            for (int k = 1; k <= maxDrop; k++) {
                byte below = nav.cls(x, y - k, z);
                if (below == NavWorld.CLIMB) {
                    if (stand(x, y - k, z) != 0) relax(n, x, y - k, z, CLIMB_DOWN, LADDER_DOWN_COST * k);
                    break;
                }
                if (!openOrWater(below)) break;
                if (stand(x, y - k, z) != 0) {
                    relax(n, x, y - k, z, CLIMB_DOWN, LADDER_DOWN_COST + FALL_PER_BLOCK * k);
                    break;
                }
            }
        }

        if (here == 1) {
            for (int dir = 0; dir < 2; dir++) {
                int to = nav.elevatorTarget(x, y, z, dir == 0);
                if (to >= 0) relax(n, x, to, z, ELEVATOR, ELEVATOR_COST);
            }
        }
        // Not at the foot of a ladder: a block cannot go where the ladder is, nor the floor be dug from under it.
        // Not on an elevator either: measured on the test server, a bot jumping on one to put a block under itself
        // never got the block to go down there, and a block on top of an elevator would stop it working anyway.
        if (here == 1 && nav.cls(x, y, z) != NavWorld.CLIMB && !nav.onElevator(x, y, z)) {
            // Pillar up: jump and put a block under the feet.
            if (canPillar && nav.cls(x, y + 1, z) != NavWorld.CLIMB) {
                int headroom = openCost(x, y + 2, z);
                if (headroom >= 0 && !nav.nearHazard(x, y + 1, z)) {
                    relax(n, x, y + 1, z, PILLAR, PILLAR_COST + headroom);
                }
            }
            // Dig down one, only onto solid ground.
            int floor = nav.breakCost(x, y - 1, z);
            if (maxDrop >= 1 && floor >= 0 && nav.cls(x, y - 2, z) == NavWorld.SOLID && !nav.nearHazard(x, y - 1, z)) {
                relax(n, x, y - 1, z, DIG_DOWN, floor + 4.0);
            }
        }
    }

    private void relax(Node from, int x, int y, int z, byte move, double cost) {
        long k = NavWorld.key(x, y, z);
        Node n = nodes.get(k);
        double g = from.g + cost;
        if (n == null) {
            n = new Node(x, y, z);
            n.h = goal.heuristic(x, y, z);
            nodes.put(k, n);
        } else if (n.closed || g >= n.g) {
            return;
        }
        n.g = g;
        n.f = g + n.h * HEURISTIC_WEIGHT;
        n.parent = from;
        n.move = move;
        open.add(new Entry(n));
    }
}
