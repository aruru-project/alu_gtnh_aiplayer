# 部署到正式服

**需要停一次游戏服务器**（装 mod 必须重启，大约一分钟，在线的人会掉线）。大脑服务的安装和以后的更新都不用停游戏。

下面 `$SERVER` 是你的服务器目录（里面有 `mods/`、`config/`）。

## 一、装身体（mod）

```bash
tools/gradle build
JAR=$(ls -t mod/build/libs/aiplayer-*.jar | grep -vE -- '-(dev|sources)\.jar$' | head -1)

# 停服、放进 mods、启动
cp "$JAR" "$SERVER/mods/aiplayer.jar"
```

启动日志里看到 `Bridge listening on 127.0.0.1:25590` 就是装好了。首次启动会生成：

- `$SERVER/config/aiplayer/aiplayer.json`：配置（端口、允许的指令、天然方块和垫脚方块清单、默认是否无敌、`newBotCommands`）。
  想让每个 bot 都用同一个皮肤，在里面写 `"newBotCommands": ["skin {name} set 某个正版用户名"]`，重启后对新建的 bot 生效。
- `$SERVER/config/aiplayer/schematics/`：图纸目录，把 `.schematic` 放进去即可，不用重启。
- `$SERVER/config/aiplayer/bridge-token.txt`：bridge 口令，只有属主可读。

bridge 只监听本机，不需要开端口。

升级整合包时记得把这个 jar 和 `config/aiplayer/` 带过去；每次升级前先在测试实例上重新编译、重新测一遍（它靠反射读 GregTech、ModularUI 等 mod 的内部，版本变了可能要跟着改）。

<details>
<summary>用自己的管理脚本管服务器的情况（我们的做法，仅作示例）</summary>

我们的正式服由一套管理脚本管：附加 mod 放在它的 `overrides/`，在 `extras.json` 登记哈希，这样升级的预检认得它，升级时会自动带上。`$M` 是管理目录。

```bash
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

在 `$M/overrides/migration-policy.json` 的 `preserve_paths` 里加一行 `"config/aiplayer"`，升级时保留它的配置和 bridge 口令。然后停服、把 jar 复制进实例的 `mods/`、启动：

```bash
systemctl --user stop gtnh.service
cp "$M/overrides/new-server/files/mods/aiplayer.jar" "$M/instances/new-server/mods/aiplayer.jar"
systemctl --user start gtnh.service
journalctl --user -u gtnh.service -f | grep -m1 'Bridge listening'
```

</details>

## 二、装大脑

```bash
mkdir -p ~/.config/systemd/user
cp brain/aiplayer-brain.service ~/.config/systemd/user/      # 在仓库目录里执行
```

编辑 `~/.config/systemd/user/aiplayer-brain.service`，把口令文件指向正式服：

```ini
Environment=AIPLAYER_BRIDGE_PORT=25590
Environment=AIPLAYER_BRIDGE_TOKEN_FILE=/path/to/your/server/config/aiplayer/bridge-token.txt
```

模型接口需要走代理的话，把模板里代理那两行也打开。

```bash
systemctl --user daemon-reload
systemctl --user enable --now aiplayer-brain
journalctl --user -u aiplayer-brain | grep 口令      # 首次启动打印的面板口令
```

面板在 `http://这台机器的地址:28765/`（服务模板里 `AIPLAYER_PANEL_HOST=0.0.0.0`，局域网可访问，要口令）。只想本机访问就把它改成 `127.0.0.1`，再用 SSH 转发：`ssh -L 28765:127.0.0.1:28765 这台机器`。

## 三、第一次上线

1. 面板“设置”页的“模型”一节：添加服务商（接口类型、服务地址、API key、模型名），点“测试连接”；再给对话线、干活线各选一个模型（左边两张线卡上也能换）。
2. 面板“设置”页的“玩家”一节：起名字，填主人名单（你们的游戏名）；点左上角玩家卡上的“上线”。它出现在出生点。
   想让它直接出现在你身边：你在游戏里执行 `/aiplayer spawn 名字`（需要管理员权限）。
3. 给它工具：把匠魂镐、铲、斧扔到它脚边。
4. 基地在已认领的区块里的话，你执行 `/team status 名字 ally` 把它设成盟友。没设的话它在领地里挖、放、开箱子都会被拒绝，并如实告诉你“被拒绝”。
5. 皮肤：配置了 `newBotCommands` 的话自动设好；否则控制台或管理员执行 `skin 名字 set 某个正版用户名`。
6. 在游戏里叫它的名字说话。

## 更新

- **只改大脑**（提示词、模型、决策逻辑）：`systemctl --user restart aiplayer-brain`。游戏不受影响，它正在做的任务也不受影响。
- **改 mod**：重新编译，替换 `overrides/.../aiplayer.jar` 和实例里的同名文件，更新 `extras.json` 的 `sha256`，重启游戏服务器。它没做完的任务会在重启后继续。
- **GTNH 升级**：先在测试实例上跑一遍（`tools/testserver` 重新 setup 到新版本），确认它能上线、能走、能挖，再升级正式服。

## 卸载

停服，删掉实例和 `overrides` 里的 `aiplayer.jar`，去掉 `extras.json` 和 `migration-policy.json` 里对应的两处，启动。
它的玩家存档、白名单条目和 `World/aiplayer/` 留在世界里，不影响游戏；想清干净可以手动删。
