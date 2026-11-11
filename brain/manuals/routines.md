同样的步骤要重复很多遍（一样样搬几十种东西、做一串中间件、挨个检查一批容器），要一次查很多东西再算，或者要用库函数（不在工具清单里的那些）的时候看：怎么写程序调工具。

# 两种跑法
- run_program：程序在你这一轮里跑完，结果当场回来。程序里只能调“查询”类的工具（看状态、看仓库、查配方这些），不能开任务。适合一次查很多再汇总。
- start_routine：程序在后台跑，叫“例程”。它可以调你几乎所有的工具，开任务的工具会等任务做完才返回。你启动它以后就结束这一轮；它做完、出错、被停掉或者碰到上限时，你会被叫醒，看到它每一步做了什么和它的日志。适合一长串动作。
- 例程里调工具和你自己调是同一回事：同样的参数检查，每一步都记在日志里，主人在面板上看得到，也能随时停掉。

# 怎么写
- 代码是一个 async 函数的函数体，和 design 手册里说的一样（log、return 都能用）。
- 调工具：`const r = await tool("工具名", { 参数 })`。参数和你自己调这个工具时完全一样。
- 返回的 r 有三样：r.ok（成没成）、r.text（你自己调时会看到的那段文字）、r.data（同一个结果的数据，方便程序用；有些工具没有）。
- 工具失败不会让程序出错，只是 r.ok 为 false：自己判断是跳过、重试还是 return 出去。
- 开任务的工具（withdraw_items、deposit_items、go_to、craft_item、process_items……）返回时任务已经结束：r.ok 是任务成没成，r.data 是 { task, state, result, error }，和任务结束时你看到的内容一样（比如 withdraw 的 r.data.result.moved、r.data.result.missing）。
- 一步一步来：一次 await 一个开任务的工具。不用传 queue。
- 用 log 记下每一步的要紧结果（搬了什么、跳过了什么、为什么）。你被叫醒时主要靠这份日志知道发生了什么。
- return 的值最多和一个工具结果一样长（和你直接调工具时看到的一样多），更长的只给开头，并写明一共多少字符、给了多少。日志一共留 4000 字符，满了以后的不留，也会写明。结果比这长时：从 r.data 里挑要的字段，用工具自己的筛选和 page 参数缩小，或者分几次返回 r.text 的不同段。

# 库函数
- 有些“查一查、算一算”的函数不在你的工具清单里，叫库函数。run_program 的说明后面有一份索引（每个一行：名字、参数、data 里有什么）。在程序里和工具一样调：`await tool("名字", { 参数 })`，一样返回 r.ok、r.text、r.data。
- 只想看一眼结果：run_program 写一行 `return (await tool("list_stock", { contains: "钢" })).text`。要拿它的数据接着算，用 r.data。
- 只查不动的在 run_program 和例程里都能调。haul_items 会开任务，只能在例程里调。
- 各自的参数和 data：
  - list_stock { radius?, contains?, below?, at?, page? }：周围所有箱子和抽屉合成一张存货表。r.data.items 是 [{ id, meta, name, count, automated, places: [{ x, y, z, count, kind, automated }] }]（全部，不分页；r.text 一页 40 行）。at 是 { x, y, z }：以那个地方为中心看。
  - list_drawers { x, y, z, below?, page? }：抽屉管理器（或一个抽屉方块）的每一格。r.data.slots 是 [{ x, y, z, slot, id, meta, name, count, room, front, hit }]（空格是 { empty: true }；front / hit 是这一格的正面朝哪、点它时点的位置，可以原样交给 use_item 的 side / hit），r.data.total 是符合条件的总格数（一页 60 格，多了翻 page）。
  - find_uses { id, meta?, way?, contains?, page? }：一样东西能拿来做什么。只给 id/meta：r.data.ways 是 [{ way, name, recipes }]（每种方式几条）。给了 way、contains 或 page：r.data.recipes 是这一页的配方 [{ recipe, way, in: [{ id, meta, name, count } 或 { ore, name, count }], out: [{ id, meta, name, count, chance? }], fluidsIn?, eut?, ticks? }]，r.data.page、r.data.pages 是第几页、共几页。
  - list_quest_lines { player? }：任务书各章。r.data.lines 是 [{ name, en, quests, complete, available }]（后两项要有玩家的进度才有），r.data.unclaimed 是做完没领奖励的个数。
  - probe_block { x, y, z }：现在能不能挖这一格。r.data 是 { id, meta, canDig, digTicks, toolSlot, inReach, candidates: [{ slot, item, harvest, ticks, excluded }] }。
  - check_blueprint { name, x, y, z, x1?…z2?, only?, skip?, clear? }（参数和 build_blueprint 一样）：世界和图纸对比，什么都不动。r.data 是 { cells, done, toPlace, byHand, blocked, extra, willRemove, unloaded?, materials: [{ id, meta, name, need, have }], byHandBlocks, blockedBy, extraBlocks, layers }。
  - haul_items { from, to, items? }：在两个容器之间来回搬，搬完为止（任务；只能在例程里调）。r.data 是 { task, state, result, error }。
  - read_blueprint { name, draft?, from?, to? }：一张图纸里有什么，不用知道它放在哪（draft: true 读你自己的草稿）。r.data 是 { name, source, size: { x, y, z }, blocks, materials: [{ id, meta, name, count, item?, byHand? }], x, y, z, sx, sy, sz, palette, cells }，`palette[cells[(dy * sz + dz) * sx + dx]]` 是那一格；整张超过 262144 格时没有 cells，用 from、to 分块读。例子在 blueprint 手册。
  - recent_chat { minutes?, limit?, player? }：最近的聊天记录（别人说的、面板上发来的、你自己说出去的），早的在前；默认最近 30 句。r.data.lines 是 [{ time, kind, who, text, to?, speaker? }]，speaker 是说话的人当时的 { block, facing, lookingAt, ahead }。交来的事只附着当时那一轮的原话，更早的几句用它查。
  - read_log { turn?, turnTo?, from?, to?, minutes?, query?, kinds?, line?, id?, offset?, after?, before?, limit? }：你自己的活动日志（面板上“对话”页看的那一份，按天存，留最近 14 天有记录的）：每一轮开头收到的那条消息、别人说的话和你说的话、每次工具调用和结果、你写的字、两条线之间的往来、事件、出错。对话历史里较早的轮换成交接记录以后，原文还在这里。条件可以一起给：turn / turnTo 是第几轮到第几轮；from / to 是本地时间（"2026-11-11 14:30"、"11-11 14:30"、"14:30"）；query 里的词都要出现；kinds 是 said（你说的）、heard（别人说的、面板上发来的）、tools（工具调用和结果）、relay（两条线之间）、thought（你写了没说出去的）、turns（每轮开头那条消息）、events、notes、runs、calls 里的几样（calls 是模型调用的账，不点名不给）；line 是只看哪一条线的（talk 或 work，连同不分线的）；不给就是两条线的都看，每条前面写着是谁的。给了起点（turn、from、after）从头往后读，否则给最晚的那些；r.text 里每条一行加详细内容的开头，前后还有多少、怎么接着读都写着；id 读一条的全文（一次放不下时用 offset 接着读）。r.data.entries 是这一页的 [{ id, time, kind, turn?, step?, agent?, who?, text, detail?, isError? }]（detail 是全的；日志落盘时超过 8000 字符的被截过，末尾写着原长），r.data.matched 是符合条件的总数，r.data.earlier / later 是这一页前后各还有多少。
  - read_blocks、find_structure、check_structure：见 multiblocks 手册。total_materials：见 crafting 手册（r.data 里有 summary、undecided、missing、jobs、steps、raw、kept、fluids、stocked）。
- data 里的名字：name 是游戏里看到的中文名（和主人说的、和文字结果里的一样），身体给的英文原名在 en 里。统计、汇报直接用 name。
  - 你的模型不能看图时还有 view_area { x1…z2 或 radius }（世界里一个盒子的文字说明，r.data.kinds 是 [{ id, meta, name, count }]）和 view_image { name }（一张图片的尺寸和主要颜色，r.data 是 { width, height, transparent, colors }）。

# 常用的 data
- list_containers：r.data.containers 是 [{ x, y, z, id, name, kind, slots, usedSlots, items: [{ id, meta, count, name }], attached }]，r.data.total 是总数。每个容器的 items 是全的（文字里一个容器只列前 30 种）。
- get_player_position：r.data 里有 block、facing、lookingAt、ahead。
- get_status：r.data 是你的原样状态（block、inventory: [{ slot, id, meta, count, name }]、freeSlots……）。
- find_in_storage：r.data.items 和你问的一一对应，每项有 total 和 places: [{ x, y, z, count }]。
- list_designs：r.data 里有 blueprints: [{ name, size, blocks }]、drafts: [{ name, size, blocks, kinds }]、images: [{ name, width, height }]（问了哪几样就有哪几样）。
- run_command：r.data 是 { command, output: [服务器回显的每一行] }。发指令不算只查不动，只能在例程里调。
- 库函数的 data 见上一节。多方块结构还有程序里的数据（data.structure），见 multiblocks 手册。
- 别的工具没有 data 时，从 r.text 里看。拿不准某个工具给什么，先用 run_program 调一次、return JSON.stringify(r.data) 看一眼。

# 例子：把抽屉里不到 128 个的东西都搬到一个箱子里
```js
const controller = { x: -511, y: 71, z: 86 }      // 抽屉管理器
const chest = { x: -509, y: 69, z: 90 }            // 主人指的那个箱子
let page = 1, slots = []
for (;;) {
  const r = await tool("list_drawers", { ...controller, below: 128, page })
  if (!r.ok) return "看不了抽屉：" + r.text
  slots.push(...r.data.slots.filter((s) => !s.empty))
  if (slots.length >= r.data.total || r.data.slots.length === 0) break
  page++
}
log("要搬", slots.length, "格")
let moved = 0
for (const s of slots) {
  const took = await tool("withdraw_items", { container: { x: s.x, y: s.y, z: s.z }, items: [{ id: s.id, meta: s.meta, count: s.count }] })
  if (!took.ok) { log("没取成", s.name, took.text); continue }
  const put = await tool("deposit_items", { container: chest, items: [{ id: s.id, meta: s.meta }] })
  if (!put.ok) { log("没放进去", s.name, put.text); return "箱子放不下了，已搬 " + moved + " 格" }
  moved++
}
return "搬完 " + moved + " 格"
```
背包只有 36 格：取一样放一样最稳；想省来回，可以取几样再一起放，但别超过背包。

# 上限和停
- 调多少次工具、开多少个任务没有上限：几千次调用、一口气搬一万多个东西的活可以放在一个例程里做完。
- 管着它的是这几样：能跑多久（默认和最长是主人设的，start_routine 的结果里写着这一次能跑多少分钟；minutes 可以自己要，超过最长的给到最长）；连着 3 次工具失败会自动停下；程序自己的计算时间 20 秒（等工具结果的时间不算，不调工具的死循环会被停掉）；每秒调工具的次数有上限，超了的那次自动等一下再调，不算失败。
- 每一步（参数、结果全文、用时）都记在这次运行的记录里，主人在面板上能逐步看。你被叫醒时拿到的是最近 12 次调用（每次一行）和程序 log 的最后 40 行：要带回来的数放进 return 或 log。
- 同一时间只能有一个例程。它在跑的时候你还是会被别的事叫醒：routine_status 看它做到哪了，stop_routine 停掉它。
- 例程在跑的时候不要自己再开任务：新任务会顶掉它正在做的那个，例程会因此停下。主人让你干别的急事时，先 stop_routine。
- 例程停下时，它已经做了的事不会撤销（搬走的东西还在新地方）。被叫醒后先看日志和现场，再决定接着做还是告诉主人。
- 例程里不能再开例程、再跑程序。大脑重启时例程会停下、正在做的那个任务被取消，重启后你会看到它停在哪；要接着做就重新开一个（先查现场，只做剩下的）。

# 什么时候不用例程
- 只有三五步的事，自己一步步调更清楚。
- 每一步都要看结果再拿主意（挑配方、问主人）的事，不要塞进例程。
- 例程跑起来不会停下来问人：要动别人的东西、数量大、或者用到标着 AUTOMATED 的容器而主人没交代过的，先问清楚再写。
