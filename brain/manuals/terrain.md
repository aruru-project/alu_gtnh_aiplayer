要平地、清空、填充、挖方块或放方块这类改动地形的活时，动手之前看。

# 先看清楚
- 不确定范围或高度时，先用 scan_area 看地形，或者直接问人，不要猜坐标。别人说“这里”“这块地”“我旁边”时，先用 get_player_position 找到他的位置，再用 scan_area 或 look_around 确认（look_around、find_blocks 给 at 就是看那个位置的周围，不用先走过去）。
- 范围或高度是你自己推测的，要人确认了再动手：report 带 question: true 问一句（不带 question 的汇报只是留个话，对话线要等下次被叫醒才看到）。
- 想看一块地方整体长什么样（地势、有什么建筑、干完的活对不对）：你的模型能看图时可以用 view_area 要一张图；精确的高度和方块还是以 scan_area、inspect_block 为准。图怎么看、看不了图时怎么办见 pictures 手册。
- 这几个工具的范围都是给两个对角，哪两个对角都行：flatten_area 是 (x1, z1) 和 (x2, z2)，clear_area、fill_area 是 (x1, y1, z1) 和 (x2, y2, z2)。
- flatten_area 填坑默认用常见的填料（泥土、圆石这类）；只想用某几种就给 fillItems（方块 id 的列表，如 ["minecraft:dirt"]）。平到哪个高度（y）拿不准时先 scan_area 看。
- 用哪个工具：flatten_area 把一块地整成某个高度的平地（挖掉上面的、填上下面的坑）；clear_area 把一个盒子里的方块全挖掉；fill_area 在盒子里的空位放上某种方块，可以只做外壳（hollow）或四面墙（walls）；零散的几个方块用 dig_blocks、place_blocks。

# 工具和材料
- **挖一格要什么工具，是那个方块自己说的：** 一类工具（pickaxe 镐、axe 斧、shovel 铲，GregTech 的 wrench 扳手……）加一个最低等级。拿不准就用库函数 probe_block 看（不在工具清单里，run_program 写一行：`return (await tool("probe_block", { x, y, z })).text`）：它写着这一格要哪一类、几级，身上每件工具为什么不行（不是这一类、等级不够、一点进度都没有）。挖的任务以 no_tool 失败时，消息里也写着这些。
  - 石头、矿石这一类用匠魂（Tinkers' Construct，id 以 TConstruct: 开头）的镐。这个整合包里原版的铁镐挖石头一点进度都没有（实测 probe：它自报 pickaxe 3 级，进度 0）。
  - GregTech 的机器外壳、机器、总线、仓、管道要的是扳手（wrench 类）：实测钢管道方块要 wrench 2 级，输入总线 wrench 0 级；铁镐、匠魂镐都不是扳手。GregTech 的扳手是 gregtech:gt.metatool.01 的一种，等级看它的材料（钢扳手 3 级）；/give 出来没有材料的扳手是 0 级。
  - 缺工具就去仓库找那一类（find_in_storage 可以按矿辞查，扳手是 craftingToolWrench），找不到问人；不要拿不是那一类的工具硬试。
- **挖得动不等于会掉所要的东西。** probe_block 的 harvest / toolRequired 是采掘资格，不是掉落表；工具不同也可能掉不同东西。方块声明能剪时，probe_block 另列原版剪刀现在能不能剪；没列不代表所有模组剪刀都不行。查询不试抽随机掉落。
  - 用指定物品左键一格：`use_item {id:"minecraft:shears", on:{x,y,z}, left:true}`。这会保持剪刀在手里，走正常点击；dig_blocks 则按速度自动选工具，对一碰就掉的植物可能选空手。硬方块只点一下不会持续挖。
  - BOP 的野生亚麻 `BiomesOPlenty:foliage/3`：本整合包的普通掉落不含亚麻植株，只在 1/8 的分支尝试从草种子表取种子，所以徒手没掉东西很正常；剪刀能取下植株（上半截 `/6` 剪下也得到 `/3`）。这是安装包的 BOP 规则，不是所有叫“亚麻”的作物都一样。实测 `/3` 用剪刀左键得到植株；9 个植株合成 1 根线，配方库也能查到。
- 一次挖一片的工具（匠魂的锤、挖掘铲、伐木斧）你不会用，免得挖到范围外面去。工具会磨损。
- 放方块要背包里有，而且旁边要有方块可以依附；没处依附的会被跳过。
- **朝向**：楼梯朝哪边升、原木横着还是竖着、台阶放上半还是下半，是 place_blocks 每一格的 blockMeta：写成放好以后 inspect_block 读到的那个 meta（楼梯 0 往东升、1 往西、2 往南、3 往北，加 4 是倒着的；原木 0–3 竖、加 4 东西向、加 8 南北向；台阶加 8 是上半）。照着一个已经放好的抄 meta 最稳。身体自己找站位、点哪个面，让它这样出来（玩家放楼梯，楼梯往远离人的方向升；原木顺着点的那个面）。
  - 给了 blockMeta 就不用给 meta（用哪种物品由身体挑：云杉原木横放 /5 用的是物品 log/1）。
  - 放不出来的格子在结果的 skipped 里写着原因：要点在哪个邻格上而那里没有方块（先放个能点的方块，或者换个顺序）、要朝哪看站在哪边而找不到那样的站位、这种物品怎么点都放不出这个 meta。放下去了却不是这个 meta 的（身体预料不到放法的方块）在 cameOutDifferent 里，挖掉重放或者告诉主人。
  - fill_area 也有 blockMeta：一整排、一整片朝向相同的（屋檐的倒楼梯、横放的原木）用它。每一块都要有能点的邻格，原木横放要有一头先靠着东西。
  - 不给 blockMeta 时朝向由站位决定，放出来是什么样就是什么样。材料不够时会去 supply 给的容器取，都没有就以 no_material 失败（detail 里有缺什么、缺多少）：去取，或者问人。
- 同一个 id 的不同 meta 是不同的方块（gregtech:gt.blockcasings2 的 0 是坚固钢机械方块，13 是钢管道方块）。fill_area、place_blocks 只放给的那个 meta，不给就是 0；这一种用完了就以 no_material 停下，不拿别的变体顶。结果里 placed from 写着放下去的方块是从哪几种物品放的。

# 大小和时间
- 一次任务的上限：flatten_area 64×64，clear_area / fill_area 32768 格，dig_blocks / place_blocks 256 个。超了就分块排队（queue: true，队列最多 32 个）。
- 这些任务可以重入：失败后用同样的参数再启动，只会做还没做完的部分。
- 要多久：挖石头大约每秒 1 到 1.5 块，泥土更快。12×12、最高要挖 15 层的平地（八百多块）大约 12 分钟；7×7 的小坡半分钟左右。别人问起就按这个估。

# 挖出来的东西
- 挖出的东西先掉在世界里，走近且背包装得下才会捡进来；removed 是挖掉的方块数，不是入包数。背包只有 36 格，开工前为产物和拆回的垫脚留位置，活大一点给 dropoff（卸货的容器）。
- inventory_full 了：先用 deposit_items 把东西存进箱子，再用同样的参数重启任务。挖出来的东西没人要、主人同意丢在地上时，可以传 overflow: "leave"。

# 施工怎么走，由你选择
- flatten_area、clear_area、fill_area、dig_blocks、place_blocks、build_blueprint 共用 dig / climb / maxDrop：默认不挖路、不自动垫脚、单次规划落差最多 3 格，无敌也一样。dig 只管为走路额外挖块，不取消点名的 dig_blocks 或任务本身的清障。
- 允许改路时给 dig:true：先找不改地形的路，走不通再按天然方块规则挖。允许垫脚时给 climb:true，并带泥土、圆石等填料；maxDrop 是愿意走下的最大落差（0–40），不是挖坑深度或施工高度。这些选择也约束补料、卸货、捡掉落时的走路。
- 高处没有站位、低矮洞里只有掉落物能塞进去时，unreachable 可能就是当前限制下的正常结果。检查实际方块和脚高，选择已有台阶/梯子/楼板，或规划临时站位再做；不要为重试一律开挖垫。
- 放置会从已有位置尝试，身体挡住目标时会让位。已经手动悬停在够得着的位置可以施工，但这些工具不会规划飞行；需要换高度用移动控制或先落地。步行接近单段最多 90 秒，持续空中又够不着时会及时失败。
- 开了 climb 才会自动垫脚；收尾尝试拆回并拾取，拆脚下支撑也遵守 maxDrop。拆不掉、捡不到的会留在结果里。
- 背包满了去 dropoff 卸货时，身上只留一组垫脚的方块，多带的泥土、圆石会一起卸进去：结果里的 unloaded 是卸下了什么。

# 看懂结果
- removed / placed 是实际挖掉和放上的数量。placed:0 时看原因：alreadyMatches 是原本已是要的方块；occupied by id/meta 是被别的方块占着而没替换；fill_area 的 no empty/replaceable cells 表示范围没有空位。skipped 按原因列出跳过了多少，skippedExamples 给出几个具体坐标。
- 跳过带数据的方块（箱子、抽屉、机器）、液体、基岩属于正常，不用管。
- 原因是 hole deeper than maxFillDepth 的，是坑太深没填：要填就把 maxFillDepth 调大再跑一次。foliage out of reach 是够不着的树叶，一般不用管。
- 收尾的 remainingDrops 列出工作/清理区域还在的掉落、位置、原因及 capacity（当前还能装多少这种物品；不同堆共用空槽，不是各自预留）。全没容量会写 inventory_full；有容量但没路则写 unreachable，必要时附掉落格及上方方块。区域也可能有原来就在的掉落，不把整张表都当成本次产物。
- 垫过脚的任务，结果里逐块列着这次垫的方块（climbing blocks put down）：在哪、现在还在不在、是不是任务自己拆的（taken down）。还在的就是留在世界里的垫脚；拆了、掉落物却没回到你身上的块数也写着（多半掉在附近地上）。removed 不算拆掉的自己的垫脚。climbingBlocksLeftStanding 是没能拆掉的个数，后面是坐标：在别人的地方干活的话，说一声或者回去拆（dig_blocks）。dug out of the way 是走路途中为了过去挖掉的方块。
