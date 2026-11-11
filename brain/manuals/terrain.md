要平地、清空、填充、挖方块或放方块这类改动地形的活时，动手之前看。

# 先看清楚
- 不确定范围或高度时，先用 scan_area 看地形，或者直接问人，不要猜坐标。别人说“这里”“这块地”“我旁边”时，先用 get_player_position 找到他的位置，再用 scan_area 或 look_around 确认（look_around、find_blocks 给 at 就是看那个位置的周围，不用先走过去）。
- 范围或高度是你自己推测的，动手前用 say 报一下，让对方有机会纠正。
- 想看一块地方整体长什么样（地势、有什么建筑、干完的活对不对）：你的模型能看图时可以用 view_area 要一张图；精确的高度和方块还是以 scan_area、inspect_block 为准。图怎么看、看不了图时怎么办见 pictures 手册。
- 用哪个工具：flatten_area 把一块地整成某个高度的平地（挖掉上面的、填上下面的坑）；clear_area 把一个盒子里的方块全挖掉；fill_area 在盒子里的空位放上某种方块，可以只做外壳（hollow）或四面墙（walls）；零散的几个方块用 dig_blocks、place_blocks。

# 工具和材料
- **工具只认匠魂的。** 这个整合包里原版工具和 GregTech 的镐、铲、斧都挖不动东西，能用的是匠魂（Tinkers' Construct，物品 id 以 TConstruct: 开头）的镐、铲、斧。没有匠魂镐去挖石头，任务会以 no_tool 失败。缺工具就向人要匠魂工具，不要拿别的工具硬试。拿不准手里的工具行不行，用库函数 probe_block 看（不在工具清单里，run_program 写一行：`return (await tool("probe_block", { x, y, z })).text`）。
- 一次挖一片的工具（匠魂的锤、挖掘铲、伐木斧）你不会用，免得挖到范围外面去。工具会磨损。
- 放方块要背包里有，而且旁边要有方块可以依附；没处依附的会被跳过。材料不够时会去 supply 给的容器取，都没有就以 no_material 失败（detail 里有缺什么、缺多少）：去取，或者问人。

# 大小和时间
- 一次任务的上限：flatten_area 64×64，clear_area / fill_area 32768 格，dig_blocks / place_blocks 256 个。超了就分块排队（queue: true，队列最多 32 个）。
- 这些任务可以重入：失败后用同样的参数再启动，只会做还没做完的部分。
- 要多久：挖石头大约每秒 1 到 1.5 块，泥土更快。12×12、最高要挖 15 层的平地（八百多块）大约 12 分钟；7×7 的小坡半分钟左右。别人问起就按这个估。

# 挖出来的东西
- 挖出来的东西（圆石、泥土等）都进你的背包，背包只有 36 格。活大一点就要给 dropoff（卸货的容器），不然背包一满任务就以 inventory_full 失败。
- inventory_full 了：先用 deposit_items 把东西存进箱子，再用同样的参数重启任务。挖出来的东西没人要、主人同意丢在地上时，可以传 overflow: "leave"。

# 身体自己会处理的
- 走路时优先走不改动地形的路；实在走不通才会挖开挡路的天然方块（泥土、沙子、沙砾、树叶之类，不动石头和木头）。
- 够不着高处时用泥土、圆石垫脚，垫的方块任务结束前会自己拆掉。

# 看懂结果
- removed / placed 是挖掉和放上的数量，skipped 按原因列出跳过了多少，skippedExamples 给出几个具体坐标。
- 跳过带数据的方块（箱子、抽屉、机器）、液体、基岩属于正常，不用管。
- 原因是 hole deeper than maxFillDepth 的，是坑太深没填：要填就把 maxFillDepth 调大再跑一次。foliage out of reach 是够不着的树叶，一般不用管。
- 结果里有 climbingBlocksLeftStanding 时，是有几块垫脚的方块没能拆掉：在别人的地方干活的话，说一声或者回去拆。
