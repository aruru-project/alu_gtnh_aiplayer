要把直升机背包、喷气背包、探险背包穿到背上或脱下、给它们加油，按 mod 加的键，或者要飞起来时看。

# 背上那一格
- 探险背包（adventurebackpack）这个 mod 的三样东西穿在背上，不占盔甲格：直升机背包（adventurebackpack:copterPack，烧液体燃料飞）、煤喷气背包（adventurebackpack:coalJetpack，烧煤把水烧成蒸汽往上推）、探险背包（adventurebackpack:adventureBackpack，一个大包加两个液体罐）。背上一次只有一件。
- get_status 里 `Worn on your back` 那一行就是背上那件：它是什么；它的罐里有多少（玩家屏幕角上画着的那几个罐）；它自己存的数据（`its data`，键是这个 mod 起的名字，值原样）。
- 穿上：`open_screen { item: { id: "adventurebackpack:copterPack" } }` 打开它的界面（玩家是拿在手里右键），界面上有个按钮 `equip`（"Shoulder Copter Pack"），`use_control { key: "equip" }` 按它，它就到了背上，界面随之关上，结果里写着背上现在是什么。
- 脱下：`press_key { key: "keys.adventureBackpack.openInventory" }` 打开背上那件的界面，按钮 `unequip`（"Unshoulder …"），按了以后它回到背包里（这个 mod 自己隔 0.2 秒才放回去；背包满了掉在脚边）。
- 探险背包拿在身上（没穿）时是一个随身的包：deposit_items / withdraw_items 给 `bag`（实测存、取都行）。穿在背上时用 openInventory 打开它的界面，再 click_slot。

# 键
- 这个 mod 加了两个键：`keys.adventureBackpack.openInventory`（Open Inventory）和 `keys.adventureBackpack.toggleActions`（Toggle Actions）。`press_key` 按一下，`sneak: true` 是按着 Shift 按。物品提示里写着按 'NONE'，是客户端没给这个键绑按键，和你按不按得了无关。
- openInventory：背上穿着东西时打开它的界面；手里拿着探险背包时打开手里那个；这个 mod 的界面开着时再按一下是关上。
- toggleActions 做什么看你穿着、拿着什么：
  - 直升机背包：蹲着按是开、关；不蹲按是在“普通”和“悬停”之间切换（关着时不起作用）。游戏会说 `CopterPack: Normal Mode.` / `Hover Mode.` / `Off.`。它的数据里 `wearableData.status` 就是这个：0 关、1 普通、2 悬停。
  - 煤喷气背包：蹲着按是开、关（`wearableData.status`）。
  - 探险背包：不蹲按是工具循环的开关，蹲着按是夜视的开关（只有带夜视的那几种）。手里拿着软管时：换软管接的罐。
- 键只在你没有任务在跑的时候按得了。

# 给直升机背包加油
- 它的罐 16000 mB。能烧什么由服务器的配置定（这个整合包默认有柴油 `fuel`、生物柴油、生物燃料、杂酚油、岩浆、轻燃油、重燃油、硝化柴油……）。柴油单元一个 1000 mB。
- 界面里有两个格子，结果里写着它们收你身上的哪些东西：上面那格（36）放装着燃料的单元或桶，倒进罐里以后空单元落到下面那格（37）。`click_slot` 按着 Shift 点你背包里的柴油单元，整组进去，倒到罐满为止（16 个正好装满）；再按着 Shift 点 37，把空单元拿回来。界面关上时这两格里剩下的东西会掉在脚边（这个 mod 就是这样）。
- 拿在手里打开的界面、背在背上打开的界面都能加油。罐里有多少：get_status 的 `Worn` 那一行。
- 烧得多快（柴油，测试服实测）：关着不烧；普通模式每秒约 5 mB，普通模式往上升时约 11 mB；悬停模式约 11 mB（悬停时往上升也是这些）。满罐悬停能撑二十多分钟。别的燃料烧得快慢不同（服务器配置里的倍率，柴油 0.8、岩浆 5）。

# 飞（直升机背包）
- `hold_keys` 是按住键一段时间：`jump` 是空格，`sneak` 是 Shift，`toward` 是朝一个点按住前进（边走边转向它）。什么时候松手：`seconds` 到了；`y` 给了是脚到那个高度时（升到它，或降到它）；`above` 给了是离地到那个高度时（`above: 10` 升到离地 10 格，`above: 0` 是落地时）；`range` 是离 `toward` 那个点这么近时。离地多高看的是你脚下那一列，往前飞时地面高低会变。
- 开机以后：
  - 普通模式（1）：按住跳往上升（y 100 以下每 tick 0.18 格，每秒 3.6 格；越往上越慢，250 以上不再升）；松开就慢慢往下落（每 tick 约 0.19 格）；按住潜行往下降（每 tick 0.3 格）。
  - 悬停模式（2）：不按键就停在那个高度（油照烧）；按住跳一样往上升，按住潜行往下降。一步做完到你下一步之间要隔几秒，要在半空停着等就切到悬停；悬停在地上切也行。
- 往前飞：空中最快每 tick 约 0.7 格（每秒 14 格）。松开以后还会往前滑：实测从全速松手又滑了 7.7 格才停。`range` 给 8 左右是提前松手、大约滑到那个点；或者再按一次 `toward` 回来。
- `hold_keys` 不找路：前面有山、有树就撞上去停住。飞之前用 scan_area 看看路上地面多高。go_to 这些走路的任务是在地上找路的，飞在空中时先落地再用。
- 掉进水里它自己关掉。没油时：在地上就关掉，悬停变回普通（慢慢往下落）。开着时不会摔伤。
- 例（测试服实测）：蹲着按 toggleActions 开机，不蹲再按一次切到悬停；`hold_keys { seconds: 15, jump: true, above: 10 }` 2.8 秒升到离地 10.08 格，停在那里；`hold_keys { seconds: 3 }` 悬停 3 秒，一点没动；`hold_keys { seconds: 15, toward: { x: 33, z: -10 }, range: 8 }` 向西飞了 22.5 格（2 秒）松手，接着下降的时候又滑到离那一点中心 0.05 格的地方；`hold_keys { seconds: 20, sneak: true, above: 0 }` 1.7 秒落到地上；蹲着按 toggleActions 关机。整趟用了 115 mB 柴油。

# 煤喷气背包
- 界面里有加水的两格（水桶、水单元，倒进 8000 mB 的水罐，空的落到下面那格）和一个燃料格（煤这类能烧的东西）。另一个罐是蒸汽（16000 mB）。
- 开着时（蹲着按 toggleActions）烧燃料，温度慢慢升（数据里的 `temperature`；实测从 0 到 100 用了 80 多秒），到 100 以上开始把水烧成蒸汽（实测每秒多 80 mB 左右）。
- 按住跳（`hold_keys { jump: true }`）用蒸汽往上推，每 tick 用 13 mB；y 135 以下最快每 tick 约 0.37 格（实测 3 秒从 y 86 升到 108），185 以上推不动。
- 它没有悬停，也没有慢落：松开跳就照常往下掉，越掉越快（实测从离地 22 格松手，1.5 秒落回地面），和从那么高掉下来一样会摔伤（你的无敌设置开着时不受伤）。往上推的时候不算摔落的距离。
