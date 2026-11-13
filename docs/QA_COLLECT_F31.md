# f31：捡湖底掉落物时挖路

## 发现

正式服日志 `activity-2026-11-13.jsonl`：

- 18:51:47，`dig_blocks` 点名6块黏土，任务 `tmweshp9u` 挖6块后完成，未报额外挖路。
- 18:52:05，`collect_items {x:-448,y:61,z:111,radius:6}` 开任务 `tmweshp9v`。
- 18:52:47，`done`、`pickedUpStacks:1`，但 `dugOnTheWay` 是20块草/泥土，脚在 `(-448,58,111)`；背包11黏土，随后观察还有13黏土在附近。
- 第二次 collect 又挖2泥土，`pickedUpStacks:0`，仍报完成。

这里不是只有“捡物默认允许挖路”的问题：

1. Collector 用地图目标 `Goal.near(item所在格, range=0)`。它要求走进**物品那一列**，却允许脚高差±2。整数化的±2既不是实际拾取范围，也不允许从旁边游近：例如实测掉落在 y60.78，脚在 y58 的碰撞盒加拾取范围只到 y60.3，仍捡不到；从旁边水下靠近反而能捡。
2. 原寻路只把“脚是水、头是空气”的水面当作落脚点，没有水柱上下移动；跟随路径时入水总按跳。找不到合适的拾取位置后，它会尝试挖地形，而不是从邻接水格游过去。
3. `target.isDead` 被算成捡到。物品合并、消失、被别人拿走也会死亡。并且不可达目标被跳过后，CollectTask 无条件 `done`。

GTNH 中掉落会移动/上浮；这也是为什么不能只在普通空水池里放个掉落就宣称复现了。正式服在线存档副本里的相关地层是 y60 泥巴、y61 黏土、y62 水或泥巴，邻接覆盖下的掉落稳定在 y60.78。没有历史逐 tick 的目标记录，**未证明历史20块中每一条路径是怎样选出的**。

## 改动

- 拾取 Goal 按 MC 1.7.10 实际查询：玩家碰撞盒横向扩1、竖向扩0.5，与物品碰撞盒相交；运行时用实际玩家位置判断，不拿取整后的脚格代替。掉落移动超过半格就重新找路。
- Collector 允许规划水下邻格和水柱上下移动。跟随时按目标高度按跳或松开下沉，而不是一直上浮。普通 goto 等没有开启这个水下模式，原水面路线、楼梯/梯子逻辑未改。
- 成功拾取数来自 **FML `PlayerEvent.ItemPickupEvent`**，不是可被取消的 Forge 拾取前事件。还在范围内的物品全列在 `remaining`，有剩余则失败；没有确认拾取、附近也没有可接着捡的同种堆时，目标消失报 `interrupted`。
- `collect` 增加 `dig` / `climb`。身体旧调用省略时仍是 true/true；大脑 `collect_items` 默认显式传 false/false，模型可以开启。`dig:false` 连旧垫脚也不挖，`climb:false` 不垫新块。没有全面禁止正常挖/垫。
- 非无敌玩家水下空气低于80 tick时停止收集、`interrupted`，说明仍在水下、没有返回水面。不是自动救生策略；实际死亡仍由既有任务驱动中断。
- 工具清单 work 增加161字符，58,299 → 58,460；经主控同意，此分支上限58,600。talk不变。

## 实机验证

入口：`brain/test/live-collect.ts`，真大脑 `src/main.ts` → 本地脚本模型 → 真 GTNH 身体。没有使用真实模型接口。测试服只用本 worktree 的 `tools/local.env`（游戏10286、RCON25577、bridge25592）。

固定场景 `--pond` 重建测试世界 `x -452..-444, y56..65, z108..114`，并清除这个隔离测试服的原有散落物品。它不是对正式服的操作。一个24黏土的掉落处在泥巴湖床邻接覆盖下；检查实际背包、掉落、任务结果和湖床逐格前后对比。

```sh
cd brain
node test/live-collect.ts --pond --terrain --out /tmp/aip/collect2-covered-final.json
node test/live-collect.ts --pond --out /tmp/aip/collect2-covered-default.json
node test/live-collect.ts --pond --blocked --out /tmp/aip/collect2-covered-blocked.json
node test/live-collect.ts --pond --lost --out /tmp/aip/collect2-covered-lost.json
```

- **改前、同一固定场景**：旧身体、显式允许挖/垫，约60秒取得24黏土，但额外挖6泥土；验收因 `dugOnTheWay=6` 失败。证据 `/tmp/aip/collect2-covered-before.json` 和同名 `.log`。这是实际旧实现失败，不是 mock 自证。
- **修后、允许挖/垫**：约1.4秒收齐24黏土，挖/垫0；对比世界里的泥土、石头、黏土、泥巴均未变。没有靠禁挖掩盖错误路线。
- **修后、默认不挖不垫**：同样收齐24黏土、地形不变。脚本模型实际发送的工具参数未带 dig/climb，而身体收到 false/false。
- **旧 body 调用兼容**：`--terrain` 还直接向身体发一次省略 dig/climb 的 collect，第二份24黏土也进背包，结果 done、无额外挖路。
- **普通水面 goto**：从液面起步，走到另一水格，done、无额外挖路；不重跑无关的楼梯/梯子整套。
- **不可达**：围住目标，24黏土留在世界，背包0、挖0；`failed/unreachable`，消息 `items remain; see their positions and reasons`；`remaining` 带物品、数量、实际坐标、`unreachable: no way to get there`。
- **目标消失**：寻路中从这个测试世界移走掉落，背包0、拾取数0；`failed/interrupted`，消息 `an item target disappeared without a confirmed pickup`，`disappearedTargets:1`，不假报捡到。

输出 JSON 保留脚本模型看到的全文、任务结果、位置/掉落采样和前后地形。一般检查日志：`/tmp/aip/collect2-npmtest.log`、`collect2-typecheck.log`、`collect2-final-build.log`。`npm test`、`npm run typecheck`、`tools/gradle build -q` 通过。

## 没证明 / 遗留

- 在线存档副本恢复6黏土和事故记下的22土后，旧体重放 dig → collect 额外挖1草，未复现历史精确20块。固定场景证明同类错误走法及修正，不声称恢复了当时全部掉落实体、随机运动和每一步寻路。
- 普通 goto **从水下起步**仍可能绕岸挖土：测试最初在液面传送后空等300ms，玩家先沉下去，再下 goto，看到额外挖1泥土。单独记为旧问题；这次只给拾取开启水下模式，没有修成“所有水中寻路都好了”。
- 空气不足的停止条件有代码保护，但没有在此次实机测试中耗尽非无敌玩家的空气；水下死亡后的既有重生/中断也未重测。没有设计自动返回水面的策略。
- 半路允许改地形且进展≥8格的规则没有改；没有证据把本次事故归结为该阈值，也没有顺手重写导航。
- 未部署正式服，意见f31未标已处理，未用真模型验收。
