package alu.aiplayer;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;
import net.minecraft.command.WrongUsageException;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.ChatComponentText;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.BotManager;
import alu.aiplayer.bridge.RpcException;

/**
 * /aiplayer, for server operators: a way to see and stop bots from inside the game when the brain service is not
 * at hand.
 */
public final class CommandAiPlayer extends CommandBase {

    private final BotManager bots;

    CommandAiPlayer(BotManager bots) {
        this.bots = bots;
    }

    @Override
    public String getCommandName() {
        return "aiplayer";
    }

    @Override
    public int getRequiredPermissionLevel() {
        return 2;
    }

    @Override
    public String getCommandUsage(ICommandSender sender) {
        return "/aiplayer list | spawn <name> | despawn <name> | stop <name>";
    }

    @Override
    public void processCommand(ICommandSender sender, String[] args) {
        if (args.length == 0) throw new WrongUsageException(getCommandUsage(sender));
        try {
            switch (args[0]) {
                case "list":
                    if (bots.all()
                        .isEmpty()) reply(sender, "No AI players.");
                    for (Bot b : bots.all()) {
                        if (!b.online()) {
                            reply(sender, b.name + ": offline");
                            continue;
                        }
                        String task = b.tasks.active() == null ? "idle" : b.tasks.active().type;
                        reply(
                            sender,
                            b.name + ": dim "
                                + b.player().dimension
                                + " at "
                                + b.blockX()
                                + " "
                                + b.blockY()
                                + " "
                                + b.blockZ()
                                + ", "
                                + task);
                    }
                    break;
                case "spawn": {
                    String name = arg(sender, args);
                    double[] pos = null;
                    Integer dim = null;
                    if (sender instanceof EntityPlayerMP) {
                        EntityPlayerMP p = (EntityPlayerMP) sender;
                        pos = new double[] { p.posX, p.posY, p.posZ };
                        dim = p.dimension;
                    }
                    Bot existing = bots.find(name);
                    // A bot that has been online before returns to where it logged out.
                    Bot b = bots.spawn(name, dim, existing == null ? pos : null, null);
                    reply(sender, b.name + " is online.");
                    break;
                }
                case "despawn":
                    bots.despawn(bots.require(arg(sender, args)));
                    reply(sender, "Logged out.");
                    break;
                case "stop": {
                    int n = bots.require(arg(sender, args)).tasks.cancel(null);
                    reply(sender, "Canceled " + n + " task(s).");
                    break;
                }
                default:
                    throw new WrongUsageException(getCommandUsage(sender));
            }
        } catch (RpcException e) {
            reply(sender, e.getMessage());
        }
    }

    private String arg(ICommandSender sender, String[] args) {
        if (args.length < 2) throw new WrongUsageException(getCommandUsage(sender));
        return args[1];
    }

    private static void reply(ICommandSender sender, String text) {
        sender.addChatMessage(new ChatComponentText("[aiplayer] " + text));
    }

    @Override
    public List<String> addTabCompletionOptions(ICommandSender sender, String[] args) {
        if (args.length == 1) {
            return getListOfStringsMatchingLastWord(args, "list", "spawn", "despawn", "stop");
        }
        if (args.length == 2) {
            List<String> names = new ArrayList<>();
            for (Bot b : bots.all()) names.add(b.name);
            return getListOfStringsMatchingLastWord(args, names.toArray(new String[0]));
        }
        return new ArrayList<>(Arrays.<String>asList());
    }
}
