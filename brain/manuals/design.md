主人让你自己设计建筑、把图片做成像素画，或者有值得写段程序来算、来查的事时看。

# 什么时候自己写程序
- 主人让你“造一个……”“设计一个……”，而服务器上没有现成的图纸（list_blueprints）；或者他传了图片让你做像素画：用 run_program 写一段 JavaScript，让程序把图纸画出来。不要用 place_blocks 一块块摆。
- 要算数、统计、在任务书和物品表里成批地查东西，也可以写程序。
- 程序只做计算，碰不到游戏世界。它画出来的是“草稿”，存在大脑这边；要盖出来，得先发布成图纸，再照图纸盖。

# 流程
1. 先弄清楚做什么、多大、用什么方块、盖在哪。像素画是竖着立起来还是平铺在地上，主人说了就照他的，没说就问。图片的名字和尺寸用 list_images 看。
2. run_program 写程序并存一张草稿。结果里有尺寸、材料表和字符预览；大的草稿用 view_draft 挑着看。不满意就改程序再跑，同名的草稿会被盖掉。
3. 检查样子：view_draft 加 picture（先用 "iso"，换个 from 看背面；要看里面就用 "layer" 或者用 y2 把顶切掉）。看完把哪里不对用文字说出来再改。图怎么看、能信到什么程度见 pictures 手册；你的模型看不了图时就看字符预览。
4. 告诉主人：长什么样（一两句）、多大、要哪些材料各多少、打算盖在哪，请他到控制面板的“图纸”页看草稿（那里有可以拖着转的三维预览，也有和你看到的一样的图）。然后等他同意。他说过“直接盖”的，可以不等。
5. 主人同意后 publish_draft，接下来照 blueprint 手册：check_blueprint、备料、build_blueprint。盖完可以用 view_area 看一眼盖出来的样子。
6. 用不着的草稿 delete_draft 删掉。

# 程序怎么写
- code 是一个 async 函数的函数体：直接写语句，return 一个值可以看到它，log(...) 打日志。没有 import、require、文件、网络和定时器。
- 默认最多跑 10 秒（timeout 最多给 30），内存有限。出错时结果里有报错和行号，改了再跑。
- 坐标都从 0 数：x 向东，y 向上，z 向南。发布以后，(0, 0, 0) 那个角就是 check_blueprint / build_blueprint 里 x y z 指的位置。
- 方块写成 "注册名" 或 "注册名/meta"，如 "minecraft:planks"、"minecraft:wool/14"；null 是空。拿不准注册名先用 find_item 查。

## 图纸
- blueprint(宽, 高, 长)：一张空图纸，x 方向宽、y 方向高、z 方向长。下面的 b 就是它。
- b.set(x, y, z, 方块)，b.get(x, y, z)。
- b.fill(x1, y1, z1, x2, y2, z2, 方块)：实心的盒子；方块给 null 就是挖空。
- b.box(…)：空心的盒子，只有六个面。b.walls(…)：只有四面墙。b.line(…)：两点之间连一条线。参数和 fill 一样。
- b.save("名字")：存成草稿。不 save 什么都不会留下。
- b.width、b.height、b.length 是三个方向的尺寸。

## 图片和颜色
- 想知道一张图片画的是什么，用 view_image 看（不是在程序里）。
- images()：主人传的图片，[{ name, width, height }]。
- image("名字")：一张图。img.width、img.height；img.pixel(x, y) 给 [r, g, b, a]，(0, 0) 是左上角，a 小于 128 当透明。
- img.resize(宽, 高)：缩成一张小图（每格取平均色）；不给高就按比例。先缩到要盖的大小，再一格一个方块。
- palette()：能拿来配色的方块，[{ id, meta, name, color: [r, g, b] }]。
- nearestBlock(r, g, b) 或 nearestBlock([r, g, b])：颜色最接近的方块，可以直接交给 b.set。后面再跟一个列表就只在这些方块里挑，如 nearestBlock(r, g, b, ["minecraft:wool"])。

## 本地资料
- data.available() 看现在有哪几样。data.items()、data.item(id, meta) 是物品表；data.quests()、data.questLines() 是任务书。

# 例子：小屋
```js
const b = blueprint(7, 6, 7)
b.fill(0, 0, 0, 6, 0, 6, "minecraft:planks")          // 地板
b.walls(0, 1, 0, 6, 3, 6, "minecraft:planks/2")       // 四面墙，三格高
b.fill(3, 1, 0, 3, 2, 0, null)                         // 北墙中间留门洞
b.set(1, 2, 0, "minecraft:glass").set(5, 2, 0, "minecraft:glass")   // 门两边的窗
b.fill(0, 4, 0, 6, 4, 6, "minecraft:wool/14")         // 屋顶
b.fill(1, 5, 1, 5, 5, 5, "minecraft:wool/14")         // 屋顶收一圈
b.save("小屋")
```

# 例子：像素画
竖着立起来、正面朝南（从南边看过去是正的）：
```js
const img = image("cat").resize(32)                    // 32 格宽，高按比例
const b = blueprint(img.width, img.height, 1)
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const [r, g, bl, a] = img.pixel(x, y)
    if (a < 128) continue                              // 透明的地方空着
    b.set(x, img.height - 1 - y, 0, nearestBlock(r, g, bl))   // 图片的上边在高处
  }
}
b.save("cat-art")
```
平铺在地上（图片的上边朝北）：图纸改成 blueprint(img.width, 1, img.height)，放方块改成 b.set(x, 0, y, …)。

# 现在的限制
- 照图纸盖的时候只会放整块的普通方块。楼梯、半砖、原木、门、火把、箱子这类带朝向或带内容的方块会被跳过，留给人放。所以设计时尽量只用整块方块（木板、石头、砖、羊毛、玻璃……）；非用不可的，提前告诉主人哪些得他自己放。
- 图纸不旋转、不镜像：朝哪边在程序里定好。
- 一张图纸每边最多 256 格。一次建造最多盖 64×64 列，更大的要分块（见 blueprint 手册）。
- 配色用的方块不多时（只有羊毛和染色粘土），照片的颜色会偏；图标、卡通这类颜色少的图效果好。
- 草稿只是数据：材料要你和主人去备，方块在这个服务器上有没有、你放不放得了，check_blueprint 才知道。
