要看仓库里有什么，从箱子、抽屉里存东西、取东西、在容器之间搬东西，或者把东西递给玩家、捡地上的东西时看。

# 能存取的容器
- 两类：有界面的储物方块（箱子、铁箱子、各种 mod 的箱子），和抽屉（Storage Drawers）。多方块机器的总线和仓也可以当容器存取。
- 抽屉你是像玩家那样用的：身体会走到抽屉正面，左键取、右键存，数量精确。这些动作由任务替你做，你只要把抽屉的坐标当成容器坐标交给工具。
- deposit_items 往抽屉放某一种东西的全部（items 里那一项不给 count）时，身体对那一格双击一次就全进去了（10 组 640 个约 1 秒）；给了 count 的照样精确到个（只放其中 100 个，就是 100 个）。
- 抽屉每一格在正面的哪里，list_drawers 的 data.slots 里写着：front 是正面朝哪，hit 是点这一格时点的位置。想自己对某一格点（比如拿着东西连点两下全放进去），把这两个原样交给 use_item 的 side 和 hit，例子在 inventory 手册。
- deposit_items（存）、withdraw_items（取）的容器位置，还有别的任务的 supply（取材料）和 dropoff（卸货），都既可以是箱子也可以是抽屉。
- 在两个容器之间来回搬（要跑几趟就跑几趟，你背包里原有的东西不动）：库函数 haul_items。它不在工具清单里，会开任务，所以写在例程里：start_routine 的程序里 `await tool("haul_items", { from: { x, y, z }, to: { x, y, z }, items: [{ id, meta, count }] })`（不给 items 就是全搬）。只搬一两样时，自己先 withdraw_items 再 deposit_items 也一样。
- 你身上的背包这类包也能存取（deposit_items / withdraw_items 给 bag），做法在 inventory 手册里。
- 机器也能当容器，哪个 mod 的都行（界面里有“放不进东西的格子”的就是机器）：deposit_items 是放进它能放东西的格子；withdraw_items 默认只从产物格取，给 fromInputs:true 才取其余格子里的（主人留在里面的模具、模头、燃料）。那是主人摆好的，取之前先问，用完放回去。
- 存取任务对付不了的界面（要放进指定的某一格、要一格格点的）：open_screen 打开自己点，见 screens 手册。

# 覆盖板里的东西
- 覆盖板是 GregTech 贴在机器或管道某个面上的一块板（传送带、泵、槽位扩展……）。其中“槽位扩展”自带 9 格，主人常把模具、编程电路这类东西放在里面。
- 这些东西不在机器自己的格子里：list_containers、find_machines、inspect_block 把每个面的覆盖板和它装着什么单独列出来；find_in_storage 搜得到，那一处写着“in the cover … on its west face”，后面跟着取它用的容器。
- 取和放：容器位置带上 side（哪个面）和 sneak: true。`withdraw_items { container: { x: -525, y: 70, z: 41, side: "west", sneak: true }, items: [{ id: "gregtech:gt.metaitem.01", meta: 32322, count: 1 }] }`。身体走过去、蹲着点那个面，打开的是覆盖板自己的界面，就往那个界面里存取。
- 这是通用的：有的方块点不同的面、蹲不蹲，打开的界面不一样。side 和 sneak 就是告诉身体怎么点；自己开来看用 open_screen 的 side、sneak（见 screens 手册）。

# 流体罐
- 装流体的方块（机器的罐、储罐、超级缸）里现在有什么：inspect_block、list_containers、find_machines 的结果里写着，每个罐是 多少 of 容量 mB 什么流体 [fluid 内部名]，空罐写 empty。
- 流体不是物品，不能直接存取；能查它怎么来、能做什么（crafting 手册的“流体”）。

# 看仓库
- **主人说的是某个地方的东西，就以那个地方为中心看，不要以自己为中心。**下面这几个工具（还有 look_around、find_blocks、find_machines）默认看的是你身边；给 at（一个坐标）就改成看那个地方的周围。“我这边的箱子”：先 get_player_position 找到主人，at 给他的位置。“抽屉管理器旁边那个箱子”：at 给抽屉管理器的坐标。你站在几十格外时，以自己为中心什么也看不到，这不等于没有。
- 只想知道某几样东西放在哪：find_in_storage，可以按 id 或矿辞名一次查好几样。机器上覆盖板里的东西它也搜（见下面“覆盖板里的东西”）。
- 想知道这片仓库一共有什么：库函数 list_stock，把范围里所有箱子和抽屉的东西合成一张总表，多的在前；contains 按名字筛，below 只看少于某个数的。库函数不在工具清单里，用 run_program 写一行程序调：`return (await tool("list_stock", { contains: "钢" })).text`；要接着算就用 r.data.items（见 routines 手册的“库函数”）。
- 一个个容器看：list_containers，由近到远一页 20 个。一页里每个容器只列前 30 种东西，行尾写着“… and N more kinds”的就是还有没列的。
- 把一个容器看全（大箱子里上百种东西）：list_containers 给 at（那个容器的坐标）和 radius: 0，它里面的每一种都列出来。在程序里，r.data.containers 里每个容器的 items 一直是全的。
- 抽屉管理器（[drawer controller]）自己不装东西，它管着一片抽屉：库函数 list_drawers 给它的坐标，列出它管的每一格是什么、真实有多少、在哪个抽屉方块；below 只列少于某个数的。一样用 run_program 调：`return (await tool("list_drawers", { x, y, z, below: 128 })).text`。从抽屉取货时，容器坐标用那一格所在的抽屉方块。
- 这些结果都是分页的，开头写着一共多少、这是第几到第几个。要看全就翻页，不要把一页当成全部。
- 抽屉的数量是真实库存（一格可以上万）。

# 接着管道的容器
- 标着 AUTOMATED 的容器旁边接着漏斗或管道，是主人自动化的一环：往里放的东西可能马上被抽走，拿走里面的东西可能打断生产。
- 动它之前先问主人。主人让你“放到箱子里”而有几个箱子可选时，挑没标 AUTOMATED 的，或者问他是哪个。

# 主人指着说
- 主人说话时，消息下面那一行写着他站在哪、面朝哪、准星指着什么、面前有哪些容器。他说“这个”“那个箱子”“我面前的”，以他指着的为准，其次是面前最近的那个。
- 有两个都像而他没有指着其中一个时，先问。之后想再看他指着哪，用 get_player_position。

# 存和取
- 要存、要取、要搬、要递的东西都写成清单 items，每一项是 { id, meta, count }：不给 meta 是不分 meta，不给 count 是全部。工具结果里写成 id/meta 的（如 gregtech:gt.metaitem.01/11305），斜杠后面的数就是 meta，分开填。
- deposit_items 不给 items 时，会把除工具、食物和 keep 以外的东西全存进去。
- withdraw_items 取的数量是精确的。即使容器里的东西不够也算“完成”：看结果里的 missing，缺了什么要告诉对方或去别处找。
- 往抽屉里存：一种物品只能放进已经装着它的那一格，或者还没指定物品的空格；都没有就是放不下（container_full）。所以抽屉适合存取固定的那几种东西，挖出来的杂物要卸货还是找箱子。
- container_full 是目标放不下：换个容器，或者问人。
- denied 是被领地保护拒绝，或者抽屉封了箱：不要重试，告诉对方这里你动不了。
- 一样样搬几十种东西（“把抽屉里不到 128 个的都搬到那个箱子”）时，不要自己一个个调工具：写一个例程，见 routines 手册。

# 递东西和捡东西
- give_items 走到玩家面前把东西扔给他；他不在附近会以 unreachable 失败，你身上没有那样东西会以 no_material 失败。
- collect_items 捡起一个位置周围掉在地上的东西，不给位置就是你脚下周围。

# 谁的东西
- 别的玩家的箱子、抽屉里的东西不要拿。主人基地里的仓库，办他交代的事时可以取用，数量明显大的先问；他说过不许动的不动。
- 服务器重启后没做完的任务会从头重来：withdraw 会再取一份，haul 手上的那趟货会留在你身上。重启后看一眼背包，多出来的放回去。
