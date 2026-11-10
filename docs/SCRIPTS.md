# 写程序的工具（run_program）

让 AI 玩家自己出设计：它写一段 JavaScript，大脑在沙箱里跑，产物是**图纸草稿**；主人在面板上看过同意了，草稿才发布成服务器上的图纸，之后照现有的办法盖。

```
模型写程序 ──run_program──▶ 沙箱子进程 ──▶ 草稿（数据目录 drafts/）──▶ 面板“图纸”页给主人看
                                                    │ 主人同意
                                                    ▼
                              publish_draft ──▶ .schematic ──blueprint.put──▶ 服务器上的图纸 ──▶ check_blueprint / build_blueprint
```

程序是纯计算：画图纸、读图片的像素、查本地资料、算数。它**动不了游戏世界**，动世界仍然只走现有的工具和任务。

## 工具

| 工具 | 做什么 |
|---|---|
| `run_program(code, timeout?)` | 跑一段程序。结果里有日志、`return` 的值、存下的每张草稿的尺寸和材料表；草稿小的话直接带预览。出错时给报错、行号和调用栈 |
| `list_images()` | 主人在面板上传的图片：名字、宽高 |
| `list_drafts()` | 草稿：名字、尺寸、方块数 |
| `view_draft(name, along?, x1…z2?, program?)` | 看一张草稿：材料表，加一片片的字符画（带图例）。`along` 是 `y`（一层层俯视）、`z`（从南面看的竖切面）、`x`（从西面看）；不给就沿最薄的方向。大草稿按约 4000 字符的预算画，画不下的写明没画哪些，用 `x1…z2` 指定范围再看。`program: true` 把生成它的程序也给出来 |
| `publish_draft(name, as?)` | 把草稿转成 `.schematic`，经 `blueprint.put` 发给身体（同名覆盖） |
| `delete_draft(name)` | 删草稿（不影响已经发布的图纸） |

规矩（写在 `brain/manuals/design.md` 里）：自己设计的东西，先把样子、材料、打算盖在哪告诉主人，主人同意再发布和开工；主人说过“直接盖”的除外。

## 程序能用的 API

`code` 是一个 async 函数的函数体：直接写语句，可以 `await`，`return` 的值会显示在结果里。全局只有 JavaScript 语言自带的对象（`Math`、`JSON`、`Map`、类型化数组……）和下面这些。

**坐标**都从 0 数：x 向东，y 向上，z 向南。发布以后，草稿的 (0, 0, 0) 角就是 `check_blueprint` / `build_blueprint` 的 `x y z`。
**方块**写成 `"注册名"` 或 `"注册名/meta"`（meta 0–15），也可以是 `{ id, meta }`；`null` 是空。

| | |
|---|---|
| `blueprint(宽, 高, 长)` | 一张空图纸（x 方向宽、y 方向高、z 方向长）。每边最多 256，总共最多 200 万格 |
| `b.set(x, y, z, 方块)` / `b.get(x, y, z)` | 放一个 / 看一个。越界抛 `RangeError` |
| `b.fill(x1, y1, z1, x2, y2, z2, 方块)` | 实心盒子（两个角都含，哪个在前都行） |
| `b.box(…)` / `b.walls(…)` / `b.line(…)` | 空心盒子（六个面）/ 四面墙 / 两点连线，参数同 `fill` |
| `b.save(名字)` | 把现在的样子存成草稿。一个程序最多存 8 张；程序出错的话一张都不留 |
| `b.width` `b.height` `b.length` `b.size` | 尺寸 |
| `images()` | 主人传的图片：`[{ name, width, height }]` |
| `image(名字)` | 一张图：`img.width`、`img.height`、`img.pixel(x, y)` → `[r, g, b, a]`（0–255，左上角是 (0, 0)） |
| `img.resize(宽, 高?)` | 缩放成一张新图。缩小时每格是它盖住的那一块的平均色（按不透明度加权）；不给高就按比例 |
| `palette()` | 方块颜色表：`[{ id, meta, name?, color: [r, g, b] }]`。来自 `brain/packdata/blocks.jsonl`，没有这个文件时是内置的 16 色羊毛加 16 色染色粘土 |
| `nearestBlock(r, g, b, among?)` 或 `nearestBlock([r, g, b], among?)` | 颜色最接近的方块（返回颜色表里的一项，可以直接交给 `b.set`）。`among` 是一个方块列表，只在里面挑；`"minecraft:wool"` 指它的所有 meta |
| `data.available()` | 现在有哪几样本地资料：`items`、`quests`、`questLines` 里的几个 |
| `data.items()` / `data.item(id, meta?)` | 物品表（`items.jsonl`） |
| `data.quests()` / `data.questLines()` | 任务书（字段见 `docs/PACKDATA.md`） |
| `log(…)`，`console.log(…)` | 打日志。一共留 4000 字符，多的丢掉并说明丢了几条 |

没有的东西：`import`、`require`、`process`、文件、网络、定时器、`eval` / `new Function`。

`nearestBlock` 的“接近”用的是按红色分量加权的 RGB 距离（redmean）。对着羊毛这种偏灰的颜色表试过 CIELAB 和 Oklab，前者把纯蓝配成紫色，后者把黄、粉配成白色，这个最不离谱。想用别的算法，程序可以拿 `palette()` 自己算。

## 草稿和图片

都在大脑的数据目录里（`brain/data/`，或 `AIPLAYER_DATA_DIR`）。

| | 位置 | 上限 |
|---|---|---|
| 草稿 | `drafts/<名字>.json`：尺寸、方块种类、格子（“下标, 连续几格”的序列，顺序同 `.schematic`）、生成它的程序 | 40 张；每边 256 格，200 万格 |
| 图片 | `images/<名字>.png`（面板传上来的原样）和 `images/<名字>.rgba`（解好的像素，沙箱里的程序读这个） | 30 张；每边 256 像素，文件 512 KiB |

图片在浏览器里先用 canvas 缩到最长边 256 像素以内、转成 PNG 再上传，所以大脑只解 PNG（`brain/src/design/png.ts`：灰度、RGB、RGBA 和调色板图，各种位深；不支持隔行扫描）。

发布时写出的 `.schematic`（`brain/src/design/schematic.ts`）照 `mod/.../world/Blueprint.java` 的读法：`Width/Height/Length`、`Blocks`、`Data`，方块种类超过 255 种时加 `AddBlocks`（Schematica 的半字节顺序），`SchematicaMapping` 里是注册名 → 文件内的数字 id（空气 0，其余从 1 排起）。

## 沙箱

### 怎么跑的

每次 `run_program` 起一个新的 Node 子进程（约 30 毫秒），跑完就没了。同一时刻只跑一个。三层限制：

1. **进程这一层**（`brain/src/script/sandbox.ts`）。子进程带着 Node 的 permission 模型启动：
   `--permission`，只许读三处——`brain/src/script/`（runner 和 API 的源码）、数据目录的 `images/`、本地资料里程序能查的那几个文件；
   没有任何写权限；不许起子进程、worker、原生模块、WASI、调试器。环境变量是空的，标准输入只有这次的请求。
2. **vm 这一层**（`runner.mjs` + `prelude.js`）。程序跑在一个全新的 `node:vm` 上下文里（`vm.constants.DONT_CONTEXTIFY`）：
   全局对象上只有 JavaScript 语言内置的东西和上面那张表里的 API。宿主那边一个对象都没递进去：API 是在上下文里面定义的，
   它和宿主之间只有一个“字符串进、字符串出”的函数（打日志、读一张图、读一份资料）。进程带 `--disallow-code-generation-from-strings`，`eval` / `new Function` 在上下文内外都不能用。
3. **资源**。

| 资源 | 上限 | 超了会怎样 |
|---|---|---|
| 时间 | 默认 10 秒，`timeout` 最多 30 秒 | vm 自己的超时把程序停掉；万一没停住，再过 1.5 秒大脑把子进程杀掉 |
| JS 堆 | 256 MiB（`--max-old-space-size`） | V8 自己中止子进程 |
| 常驻内存（大数组不在 JS 堆里） | 512 MiB | 大脑每 25 毫秒看一次 `/proc/<pid>/statm`，超了就杀。**只在 Linux 上有** |
| 标准输出（草稿从这里回来） | 16 MiB | 杀掉 |
| 日志 / 返回值 | 4000 / 2000 字符 | 截断并说明 |

程序交回来的草稿当作不可信的 JSON，在大脑这边逐项检查（`brain/src/design/draft.ts`：名字不能带路径、尺寸和格子数要对得上、方块写法要合规）过了才落盘。

### 保证什么（都有测试，`brain/test/design.test.ts`）

- 程序死循环、吃光内存、狂打日志、把自己弄崩，都只是这一次 `run_program` 失败并说明原因；大脑进程不受影响，下一个程序照常跑。
- 程序的正常写法里没有读写文件、起进程、联网的入口：`fetch`、`XMLHttpRequest`、`WebSocket`、`require`、`import()`、`process`、`eval`、`Function`、定时器都没有或者用不了。
- 就算程序执行到了子进程自己的那一层，按这组启动参数：数据目录里的 `config.json`（API key）、记忆、历史读不到，任何文件都写不了，进程和线程起不了。
- 程序读得到的只有：主人传的图片、方块颜色表、物品表、任务书。都不是秘密。

### 不保证什么

这不是对付恶意代码的硬隔离，两层都有官方的免责声明：

- `node:vm`：Node 文档原话是 “The node:vm module is not a security mechanism. Do not use it to run untrusted code.”
- permission 模型：Node 文档原话是 “This feature does not protect against malicious code… It does not provide security guarantees in the presence of malicious code.” 它自称“安全带”，防的是写错的代码，不是存心的攻击。

具体到这里：

- **网络没有在进程这一层堵住。** 这台机器的 Node 24.22.1 的 permission 模型不管网络（`node --help` 里没有 `--allow-net`；实测带着 `--permission` 的进程 `net.connect` 连得出去）。现在靠的是 vm 那一层不给入口，外加 runner 启动时把子进程自己的 `fetch`、`WebSocket`、`process.binding`、`process.getBuiltinModule` 之类摘掉。也就是说：**联不了网这一条，只在 vm 没被突破的前提下成立。**（新版 Node 的文档里 permission 模型已经管网络了；升级 Node 后应该把这条补上并重新验证。）
- **突破 vm 之后够得着同一个用户的其他进程。** permission 模型不管发信号，也不管 `process._debugProcess(pid)`（Node 文档点了名：它能让同一用户下的另一个 Node 进程打开调试口）。runner 把这两样也摘了，大脑的启动命令加了 `--disable-sigusr1`（不响应“打开调试口”的信号），但这些同样只是多一层，不是硬保证。
- 突破 vm 靠的是 V8 / Node 的漏洞，或者 `node:vm` 已知的那类把宿主对象漏进上下文的路子。这里把已知的路子堵了（上下文里没有宿主对象；`import()` 的拒绝值是字符串而不是宿主的 Error；runner 是 ES 模块，栈上没有宽松模式的函数），没法证明没有别的。
- CPU：一个核跑满，到超时为止。没有 CPU 配额。
- 常驻内存的上限靠轮询，瞬间可能冲高一截（实测超出一成左右）；不是 Linux 就只有 JS 堆的上限。
- permission 模型会跟着符号链接走到允许范围之外：不要往数据目录的 `images/` 里放符号链接。

谁能让它跑程序：能指挥它的人（主人名单里的；没设名单就是服务器里所有玩家）。程序拿不到秘密、动不了世界，被人诱导着乱写，后果是白占一会儿 CPU、多几张草稿（有数量上限）。

想要真正的隔离，得靠操作系统：让沙箱子进程跑在另一个系统用户下，或者放进容器 / 没有网络的命名空间。这台机器上不要特权做不到（`unshare -n`、`bwrap --unshare-net` 都被 Ubuntu 24.04 的 AppArmor 拦了），所以没有做。

## 以后让程序调动作

这次程序不能动世界，但没把路堵死：程序和宿主之间那个“字符串进、字符串出”的通道（`runner.mjs` 的 `hostCall`）是按操作名分发的，现在只有 `log`、`image`、`data` 三个。要让程序调动作，是在这里加操作、由大脑这边转给 bridge——同时要想清楚的是谁来批准，而不是技术上通不通。

## 代码在哪

```
brain/src/script/sandbox.ts     起子进程、各项上限、把结果拿回来
brain/src/script/runner.mjs     子进程入口：收紧自己、建 vm 上下文、跑程序、报结果（纯 JavaScript 的 ES 模块）
brain/src/script/prelude.js     程序能用的 API，在 vm 上下文里求值（纯 JavaScript）
brain/src/design/               草稿的检查和存取、文字预览、.schematic、PNG 解码、图片存取
brain/src/tools/design.ts       六个工具（view_draft 加 picture 可以把草稿画成图）
brain/src/tools/pictures.ts     看图的工具：view_area（世界）、view_image（主人传的图片）
brain/src/render/               简图：把草稿、世界里的一块地方按方块颜色画成 PNG（见 brain/README.md 的“看图”）
brain/src/packdata/blocks.ts    方块颜色表和内置的小表
brain/manuals/design.md         给模型看的手册
```
