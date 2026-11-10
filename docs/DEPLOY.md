# 部署到正式服

正式服由 `/extra_data/gtnh_manager` 管理。下面的步骤照它的规矩来：附加 mod 放在 `overrides/`，在 `extras.json` 登记哈希，
这样 `./gtnh upgrade` 的预检认得它，升级时会自动带上。

**需要停一次游戏服务器**（装 mod 必须重启，大约一分钟，在线的人会掉线）。大脑服务的安装和以后的更新都不用停游戏。

## 一、装身体（mod）

```bash
cd ~/workshop/alu_gtnh_aiplayer
tools/gradle build
JAR=$(ls -t mod/build/libs/aiplayer-*.jar | grep -vE -- '-(dev|sources)\.jar$' | head -1)
M=/extra_data/gtnh_manager

# 1. 放进管理目录并登记
cp "$JAR" "$M/overrides/new-server/files/mods/aiplayer.jar"
sha256sum "$M/overrides/new-server/files/mods/aiplayer.jar"
```

在 `$M/overrides/extras.json` 里加一项（`sha256` 用上面算出来的）：

```json
{
  "path": "overrides/new-server/files/mods/aiplayer.jar",
  "sha256": "…",
  "sides": ["server"],
  "policy": "Server-only AI player body (alu_gtnh_aiplayer). Rebuild and re-test on the test instance before each GTNH upgrade."
}
```

在 `$M/overrides/migration-policy.json` 的 `preserve_paths` 里加一行 `"config/aiplayer"`，升级时保留它的配置和 bridge 口令。

```bash
# 2. 停服、放进实例、启动（需要你确认可以停服）
systemctl --user stop gtnh.service
cp "$M/overrides/new-server/files/mods/aiplayer.jar" "$M/instances/new-server/mods/aiplayer.jar"
systemctl --user start gtnh.service
journalctl --user -u gtnh.service -f | grep -m1 'Bridge listening'
```

看到 `Bridge listening on 127.0.0.1:25590` 就是装好了。首次启动会生成：

- `instances/new-server/config/aiplayer/aiplayer.json`：配置（端口、允许的指令、天然方块和垫脚方块清单、默认是否无敌）。
- `instances/new-server/config/aiplayer/bridge-token.txt`：bridge 口令，只有属主可读。

bridge 只监听本机，不需要开端口。

## 二、装大脑

```bash
mkdir -p ~/.config/systemd/user
cp ~/workshop/alu_gtnh_aiplayer/brain/aiplayer-brain.service ~/.config/systemd/user/
```

编辑 `~/.config/systemd/user/aiplayer-brain.service`，把口令文件指向正式服：

```ini
Environment=AIPLAYER_BRIDGE_PORT=25590
Environment=AIPLAYER_BRIDGE_TOKEN_FILE=/extra_data/gtnh_manager/instances/new-server/config/aiplayer/bridge-token.txt
```

模型接口需要走代理的话，把模板里代理那两行也打开。

```bash
systemctl --user daemon-reload
systemctl --user enable --now aiplayer-brain
journalctl --user -u aiplayer-brain | grep 口令      # 首次启动打印的面板口令
```

面板在 `http://127.0.0.1:8765/`。从别的电脑看，用 SSH 转发：`ssh -L 8765:127.0.0.1:8765 这台机器`。

## 三、第一次上线

1. 面板“模型”页：添加服务商（接口类型、服务地址、API key、模型名），点“测试连接”。
2. 面板“AI 玩家”页：起名字，填主人名单（你们的游戏名），点“上线”。它出现在出生点。
   想让它直接出现在你身边：你在游戏里执行 `/aiplayer spawn 名字`（需要管理员权限）。
3. 给它工具：把匠魂镐、铲、斧扔到它脚边。
4. 基地在已认领的区块里的话，把它加进队伍：你执行 `/team status 名字 invited`，然后在面板对话框里让它加入（它会执行 `team join 队伍名`）。
5. 皮肤：控制台或管理员执行 `skin 名字 set 某个正版用户名`。
6. 在游戏里叫它的名字说话。

## 更新

- **只改大脑**（提示词、模型、决策逻辑）：`systemctl --user restart aiplayer-brain`。游戏不受影响，它正在做的任务也不受影响。
- **改 mod**：重新编译，替换 `overrides/.../aiplayer.jar` 和实例里的同名文件，更新 `extras.json` 的 `sha256`，重启游戏服务器。它没做完的任务会在重启后继续。
- **GTNH 升级**：先在测试实例上跑一遍（`tools/testserver` 重新 setup 到新版本），确认它能上线、能走、能挖，再升级正式服。

## 卸载

停服，删掉实例和 `overrides` 里的 `aiplayer.jar`，去掉 `extras.json` 和 `migration-policy.json` 里对应的两处，启动。
它的玩家存档、白名单条目和 `World/aiplayer/` 留在世界里，不影响游戏；想清干净可以手动删。
