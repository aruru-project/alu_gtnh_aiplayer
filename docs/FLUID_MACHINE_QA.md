# f26 / f27 / f29：流体和机器信息验收

## 原因与边界

- **f26（11-13 15:51:02）**：日志里的大型不锈钢流体单元只有名字，不能证明它为空。安装的 ModularUI 2.3.94 `FluidSlotSyncHandler.readOnServer(1)` 已经走原生容器装取，GT 5.09.54.265 `MetaBaseItem.fill` 支持部分装液。旧身体代码在测试服拿真正空的 32408 单元点同一输出控件，10368 mB 橡胶一次全部装走。因此修的是内容/容量信息缺口，不能据现在的存档认定当时装了什么，也不新增远程传液。
- **f27（16:10:32）**：大脑把纯流体、已有模具配方正确计划成 inputs:[]；身体拒绝空数组。仅去掉拒绝还会进入无 input hatch 的 pouring 路径。新增独立的零投料观察路径，不改电路、不拿模具，不把观察到的活动称作自己新开的批次。
- **f29（16:56:57）**：本地配方册只有基础值。增加可选 machine/tier，调用安装 GT 的 `EUOverclockDescriber.createCalculator / OverclockCalculator`，与标准单机 NEI 的计算路径一致；不复制一个公式冒充任意机器。特殊 describer、多方块参数不全时明确不算。

## 测了什么

实机入口：`brain/test/live-fluid-machine.ts`，真实大脑进程、127.0.0.1 脚本模型、worktree 自己的测试服；无真实模型 key。脚本会在 (10,100,10) 周围摆测试场景，只在可清理的测试世界运行。

- 同一反应釜 10368 mB 橡胶、同一种 64000 mB 大型单元：空容器接受 10368；已有水拒绝混液；满同液接受 0；已有 60000 同液接受 4000。重复只读查询不改真容器；机器和鼠标两边的量相符。
- 真 MV 固化器的橡胶片：基础 8 EU/t、32 tick（1.6 秒）不变；查询预测 32 EU/t、16 tick，运行机器自己的 mEUt/maxProgress 也是 32/16。
- 已有模具、9072 mB 橡胶、机器已经在跑时调用 `process_items recipe:208950 rounds:63 moldInside:true`：到场已有 3 片，观察到 60 轮完成，实际取回 63 片；`startedByTask:false`，不带原 rounds/made，模具仍在原料格。
- 产物格已有 5 片只要 2：原有通用取货路径会先 Shift 取 5 再试图往输入格退多余，实机回归抓到了过量取货。观察模式现在只用原生整组/半组点击：最小一次是 3，因此 5 片全留原位，以 invalid + pickupLimited:{minimum:3,wanted:2} 明确失败，不空等。
- 产物格已有 4 片要 2：右键半组成功，取回 2、原位留 2，observedRounds 为 0，模具不动。
- 机器实际拿锭模做橡胶条，却请求橡胶片：以 invalid 失败，不把别的配方当成完成，锭模仍在原位。
- 多方块高炉查询超频：回未知炉温/并行/电流/倍率等，不返回预测 ticks。

本地回归：`brain/test/fluid-machine.test.ts` 从工具入口检查实际容器内容可见、零投料计划和收货数量、已有/观察/取回分栏，以及机器预测和基础值分开。临时移去容器显示、移去超频结果附加后，对应检查失败，修复已恢复。身体过量收货回归在启用有界点击之前失败、之后通过。

交付检查：`npm test`、`npm run typecheck`、`tools/gradle build -q` 均通过。测试服已 RCON 正常停服；正式服未部署，意见簿未标处理。

## 还没证明、仍有限制

- 没有证据锁定 f26 当时那只容器的真实内容；这不是对原操作缺陷的确认。
- 零投料模式的 rounds 是期望取回数量的换算，不是批次所有权或生产完成证明。外送、进入观察前已完成的加工不倒推补算。外送箱不会被此模式自动取货；非 leave 的收货目标没取齐，空闲/超时均失败并保留短缺明细。
- 有界取货只用于这次的零投料观察路径；其他旧 `withdraw`/有投料 `process` 的“整组取出再退多余”没有在这批声称修好，应另案处理。没有直接改槽、绕事件或扔地捡回。
- 非 GT 机器不支持零投料观察；多方块观察和跨多个输出总线尚未实机验收。标准单机之外的 NEI 特殊计算、并行及中途动态改变配方未作全面实机覆盖。
- 该脚本不会替代真人模型规划验收。

## 工具清单

没有新增模型工具。find_recipes 增加 machine/tier 使两条线各增加 340 字符；process_items 的空输入/expect 说明净增 32。work 58,299 → 58,671，上限 58,700；talk 29,039 → 29,379，上限 29,400。主控合并其他 worker 后统一复核。

## 本机证据路径（不入 Git）

- `/tmp/aip-fluid2/`：GT/MUI javap 核对、构建/测试日志、改坏验证 `mutant.log`。
- `/tmp/aiplayer-fluid-machine-JziVbU/`：四种容器实机成功；随后首次固化器界面尚未稳定，驱动提前读槽失败，后来补了等待真实界面。
- `/tmp/aiplayer-fluid-machine-cPupDd/`：MV 预测与实际对照、63 片实机通过；后续额外 5 片夹具电量不足，未当作产品失败。
- `/tmp/aiplayer-fluid-machine-IFFuFv/`：有界点击修复前，5 要 2 实际取 5 的失败证据。
- `/tmp/aiplayer-fluid-machine-v9y4Tm/`：有界点击后 5 要 2 安全拒绝、4 要 2 成功；后续错配方夹具最初用了错误模具 meta，已改为查询确认的 32306。
- `/tmp/aiplayer-fluid-machine-gW8xUR/`：真实锭模错配方拒绝、多方块未知参数通过。

每个目录都有 transcript、真实大脑日志和 `logs/runs/routine-*.jsonl`。脚本支持 `--only-process`、`--only-limit`、`--only-wrong`，只重跑相关场景，不反复跑整套。

## 追加审查：观察停止不等于收货完成

主控指出首版两处观察停止仍调用 done：虽有 requestedOutputsCollected:false，机器空闲或超时且 expect 未取齐时仍会发成功任务。追加修复统一收尾：非 leave 的 expect 目标未齐，以 invalid 失败，增加 missingOutputs 和 stopReason（machine_idle / wait_limit / pickup_limited）；保留已取回 outputs。expect 为空的纯观察、leave 快照继续允许 done。

换输出总线前先保存 pickupLimited（连同该总线坐标），最后仍没补齐就按保存的原因失败，避免换 trip 丢掉证据后重试。其他总线补齐时可成功；跨多总线仍未实机验收。

定向实机 `node test/live-fluid-machine.ts --only-shortfall`：
- 修前 `/tmp/aiplayer-fluid-machine-HI8mGq/`：已有 1 片、请求 2 片，取到 1 仍给 done，目标检查失败。
- 修后 `/tmp/aiplayer-fluid-machine-yGxyMJ/`：相同场景 failed，outputs 1、missingOutputs 1、stopReason machine_idle；请求 63 片限时 5 秒，failed、实际取 8、缺 55、stopReason wait_limit；无 expect 纯观察和 leave 快照仍 done，均不冒认生产完成。
- 只跑新增目标场景及 fluid-machine/controls/recipes 相关测试、typecheck、gradle build，均通过，测试服已正常停止；没有再跑整套实机场景或 npm 全套。日志 `/tmp/aip-fluid2/shortfall-*.log`。
