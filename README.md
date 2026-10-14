# 智能双链助手 (Smart Linker)

一个 Obsidian 插件：扫描当前笔记，找出其中「恰好对应某篇已有笔记名或别名（aliases）」的词，自动或一键把它们原地转成 `[[]]` 双链。帮助你快速把分散的文字与已有知识库连起来。

- **粘贴长内容自动建链**：把行数超过阈值（默认 6 行及以上）的内容粘进笔记时，自动扫描并建链，不用按快捷键；**Excalidraw 画板上粘贴多行文本同样支持**
- 也支持手动触发：按下快捷键弹窗勾选后一键转链
- 支持笔记名 **和** 别名（aliases）
- 别名链接形式为 `[[笔记名|显示文字]]`，保留原文显示
- 自动跳过代码块、数学公式、已有 `[[链接]]`、Markdown 链接、HTML 标签；行内代码（一对反引号）内**整段**等于笔记名的词可连同反引号转成 `[[链接]]`（可在设置中关闭）
- 中文友好（按字面匹配），拉丁字母可选整词匹配；复合词（如 `Chunked-prefill`、`auto_link`）视为整体，不会拆出子词
- 同一词匹配多篇笔记时可在下拉框选择目标
- **失效 `[[链接]]` 重写**：指向已删除笔记、但该词已变成某笔记别名的链接（如 `[[EAGLE]]` → `[[EAGLE-3|EAGLE]]`）也能被扫描发现并一键修复
- **同时支持 Markdown 笔记和 Excalidraw 画板**；画板里只改写底层原文（`rawText`），链接在底层生效，画布文字内容不变（要连排版都零变化，见下文「关于『排版零变化』」）
- 可按 tag 过滤（如排除带 `#private` 的笔记作为链接目标）

## 安装与启用（本地开发）

> 前置：已安装 [Node.js](https://nodejs.org/)（建议 18+）。

1. 在本目录下执行：
   ```bash
   npm install
   npm run build
   ```
   会生成 `main.js`（并自动拷贝 `manifest.json`）。
2. 打开 Obsidian → **设置 → 第三方插件**，关闭「安全模式」（如尚未关闭）。
3. 在已安装插件列表中找到 **智能双链助手**，打开开关启用。
   - 若列表未刷新，按 `Ctrl+R`（Mac `Cmd+R`）重载 Obsidian。
4. 开发期间可执行 `npm run dev` 进入监听模式，保存 `.ts` 后自动重新打包；改完后可用命令 **「重新加载本插件（改完代码后用）」** 免重启热重载。

## 使用方法

### 方式一：粘贴后自动双链（推荐）

把内容粘贴进 Markdown 笔记时，如果**粘贴内容的行数超过阈值**（默认「超过 5 行」，即 6 行及以上），插件会自动扫描刚粘贴进来的这段文字，把命中的笔记名/别名原地转成 `[[双链]]`，不需要按任何键。

- 只处理**本次粘贴的区间**（默认设置），笔记里原有的文字不会被改动。
- 链接目标是「笔记名优先」，即某词同时对应笔记名和别名时，链接到笔记名。
- 结果会以提示条告知创建了多少处链接；一次 `Ctrl+Z` 可整体撤销（粘贴与建链是两个撤销步）。
- 想临时开关：命令面板执行 **「切换：粘贴后自动双链」**（可在设置 → 快捷键里给它绑热键）。
- 阈值、处理范围、落地方式等都能在设置里调整，见下方「设置项」。

> 说明：Markdown 笔记里只监听编辑器内的**粘贴**（Ctrl+V / 右键粘贴）；拖拽文件、导入不触发。**Excalidraw 画板上的粘贴同样支持**（见下文「Excalidraw 说明」）。

### 方式二：快捷键手动触发

1. 打开任意一篇 **Markdown 笔记** 或 **Excalidraw 画板**。
2. 按 **`Ctrl+Alt+X`**（Mac 为 **`Cmd+Alt+X`**）。
   - Markdown：若选中了一段文字，只扫描选中部分；否则扫描整篇笔记。
   - Excalidraw：若选中了元素，只扫描选中元素的文字；否则扫描整块画板的所有文本元素。
3. 弹窗会列出所有命中的词：
   - 每行 = 复选框 + 命中词 → 目标笔记 + 出现次数 + 预览双链。
   - 多目标时用下拉框选择。
   - 「全选 / 反选」批量勾选；底部按钮显示将创建的链接数。
4. 点 **链接** 即可批量转为双链；Markdown 模式下 `Ctrl+Z` 可一次撤销。

### Excalidraw 说明

**画板粘贴自动双链**：在画板上粘贴行数超过阈值（默认 6 行及以上）的文本时自动建链，覆盖两种情况——

- 直接粘到画布上（Excalidraw 会新建文本元素）；
- 双击进入某个文本框粘贴，提交（Esc / 点空白）生效后自动建链。

实现方式是粘贴后轮询比对场景变化：只处理「本次新出现 / 内容变化且包含粘贴片段」的文本元素，并等到退出文本编辑后才写回，避免和 Excalidraw 的文本编辑器打架。

**链接怎么写入画布的**（关键设计）：

| 字段 | 是否由本插件写入 | 说明 |
|------|------------------|------|
| `rawText` | ✅ **只写这一个**（另同步 `originalText` 作兼容） | 含 `[[笔记名\|原文]]` 的原文。Excalidraw 插件以此识别链接 → 反向链接、图谱、`Ctrl+单击` 跳转 |
| `text` / `originalText` / `x` / `y` / `width` / `height` | ❌ 不碰，由 Excalidraw 自己回写 | 画布展示文字与文本框几何 |

> 依据（obsidian-excalidraw-plugin 2.22.0-2 源码）：`addElements()` 会拿 `rawText` 调 `addTextElement(id, text, rawText)`（内部 `parse(rawText)`），随后在 `textMode === parsed` 时用 `refreshTextDimensions()` 自己回写 `text` / `originalText` / `x` / `y` / `width` / `height`。
> 也就是说 **`rawText` 是唯一解析源，其余字段 Excalidraw 说了算**——插件若也去改，只是跟它的原生逻辑打架，还可能留下与重载后不一致的中间值。

**关于「排版零变化」**：画布上最终显示成什么样，取决于 Excalidraw 自己的两个设置（都支持用 frontmatter 按画板覆盖）：

| Excalidraw 设置 | 对应 frontmatter 键 | 影响 |
|---|---|---|
| Show `[[brackets]]` around links | `excalidraw-link-brackets` | 链接两侧是否显示 `[[]]` |
| Link prefix | `excalidraw-link-prefix` | 含链接的文本前面是否加前缀（默认 `📍`） |

- 两者都关（`false` / `""`）时，`[[笔记名|原文]]` 的展示文字**恰好等于原文** → 加链接前后文字与文本框尺寸完全一致，即**真正的排版零变化**。
- 任一个开着，文字变成链接后画布上就会多出 `📍` / `[[]]`，文本框会相应变宽。这是 Excalidraw 的原生行为，本插件不会擅自改它的设置。
- 想省事：开启本插件设置里的 **「排版零变化（关闭画板上的链接装饰）」**，写链时会自动给该画板写入 `excalidraw-link-brackets: false` 与 `excalidraw-link-prefix: ""`（代价是会同时去掉该画板上*所有*已有链接的装饰，且需重开画板生效）。这两个键是 Excalidraw 官方支持的按画板覆盖项，也可以手动写进画板 frontmatter。

> 实测对照（同一块画板、同一个 6 行文本元素，`Kernel 优化全流程总览\n测试词 经典论文列表\n…`）：
>
> | 画板装饰 | 加链接后的画布文字 | 文本框宽×高 |
> |---|---|---|
> | 开（`📍` + `[[]]`） | `📍…测试词 [[经典论文列表]]…` | 368×270 → **417×270** |
> | 关 | `…测试词 经典论文列表…`（与原文一字不差） | 368×270 → **368×270** |
>
> 两种情况下 `rawText` 都写入了 `[[经典论文列表|经典论文列表]]` 并已保存到文件。

- 写回走官方 `ExcalidrawAutomate.addElementsToView(false, true, false, true, "IMMEDIATELY")`：**会自动保存**，且 `captureUpdate=IMMEDIATELY` 让这次改动可被 `Ctrl+Z` 撤销。
- 需要 Excalidraw 插件（官方版或 ymjr 等分支）已启用并打开画板；API 入口是 `window.ExcalidrawAutomate.getAPI(view)`（**每次调用都返回新实例**），另有插件实例 `ea` 作为退路。
- 画布上带 `[[链接]]` 的文字：`Ctrl+单击` 打开笔记。
- 元素级链接（整块图形可点击）需要在 Excalidraw 设置里开启 **「同步元素链接与文本」**（syncElementLinkWithText）。

### Excalidraw API 备忘（给后续维护）

Excalidraw 暴露两套 API，容易踩坑：

- `view.excalidrawAPI`（Excalidraw React 的 imperative API）只有 `getSceneElements()` / `updateScene()` / `getAppState()` / `selectElements()` 等，**没有** `getViewElements()` / `setViewElements()`。早期版本的本插件误用了这两个方法，这正是画板上「报错 / 没反应」的根因。
- 需要 `getViewElements()` / `getViewSelectedElements()` / `getElement()` / `copyViewElementsToEAforEditing()` / `addElementsToView()` 时，必须用 **ExcalidrawAutomate**：`window.ExcalidrawAutomate.getAPI(view)`。
- `getAPI(view)` **每次返回新实例**（并 push 进插件的 `eaInstances`），因此用完要 `ea.destroy()`；这也是官方内部代码的写法。
- `refreshTextElementSize(id)` 只是把 `width/height` 按当前 `text` 重算一遍；既然 `text` 与几何都由 Excalidraw 自己回写，本插件**不再调用它**。

### 复合词规则

`Chunked-prefill`、`auto_link`、`category` 这类连续字母数字串（含连字符、下划线）会被视为一个整体词，因此笔记名 `prefill` 不会匹配到 `Chunked-prefill` 内部的 `prefill`。中文按字面匹配，不受此影响。

## 修改快捷键

默认 `Ctrl+Alt+X`。如需修改：

**设置 → 快捷键**，搜索命令「**智能链接已有笔记**」，点后面的按钮录入新快捷键。

另有两个命令可按需绑键：

- 「**切换：粘贴后自动双链**」——一键开关自动建链
- 「**重新加载本插件（改完代码后用）**」——改完代码免重启 Obsidian 直接热重载

## 设置项

### 粘贴自动双链

| 设置 | 默认 | 说明 |
|------|------|------|
| 粘贴后自动双链 | 开 | 总开关。粘贴内容行数超阈值时自动建链 |
| 触发行数 | 5 | 粘贴内容的行数**严格大于**该值才触发；默认 5 → 6 行及以上触发 |
| 处理范围 | 只处理粘贴的内容 | `只处理粘贴的内容`＝仅给本次粘贴进来的文字建链；`整篇笔记`＝连同笔记其余文字一起建链 |
| 落地方式 | 直接写入 | `直接写入`＝按默认目标静默建链（一次 Ctrl+Z 整体撤销）；`弹窗确认`＝先弹候选列表让你勾选 |
| 跳过歧义词 | 关 | 开＝某词对应多篇笔记时不自动建链，留给手动触发处理 |
| 显示结果提示 | 开 | 开＝建链后弹提示告知数量 |
| Excalidraw 画板：粘贴后自动双链 | 开 | 画板上粘贴超阈值多行文本时也自动建链（需上方总开关为开） |

### Excalidraw 画板

| 设置 | 默认 | 说明 |
|------|------|------|
| 总是写入 `[[笔记名\|原文]]` | 开 | 开＝双链的显示文字取「原文」，画布文字不会变成笔记名；关＝同名词写成 `[[笔记名]]`，画布文字会变成笔记名 |
| 排版零变化（关闭画板上的链接装饰） | 关 | 开＝写链时自动给该画板写入 `excalidraw-link-brackets: false` + `excalidraw-link-prefix: ""`，使画布文字与文本框尺寸在加链接前后完全一致。代价：会同时去掉该画板上*所有*已有链接的 `📍` / `[[]]` 装饰，且需重开画板生效 |
| Excalidraw 插件设置检查 | — | 只读展示链接装饰的**当前生效值**（含当前画板的 frontmatter 覆盖）、同步元素链接状态，并给出跳转按钮（不改动别人的设置） |

### 匹配规则

| 设置 | 默认 | 说明 |
|------|------|------|
| 最小词长度 | 2 | 短于此长度的笔记名/别名不参与匹配 |
| 包含笔记名 | 开 | 把笔记文件名作为可链接词 |
| 包含别名（aliases） | 开 | 把 frontmatter aliases 作为可链接词 |
| 排除当前笔记自身 | 开 | 不把当前笔记自身作为链接目标 |
| 排除标签（tags） | 空 | 带这些标签的笔记不作为链接目标，逗号分隔，支持层级（如 `private` 同时排除 `#private/工作`） |
| 区分大小写 | 关 | 关闭时 Cat/cat 视作相同并保留原文大小写 |
| 拉丁字母整词匹配 | 开 | `cat` 不会匹配 `category` 内部；中文不受影响 |
| 跳过特殊区域 | 开 | 不在代码块/公式/已有链接等区域创建链接 |
| 行内代码内转链 | 开 | `` `EagleDraftWorker` `` 这类反引号内整段等于笔记名的词可转成 `[[EagleDraftWorker]]`（含反引号一起替换） |
| 失效 `[[链接]]` 重写 | 开 | 指向已删除笔记、但命中某笔记别名的链接会被列出并重写，如 `[[EAGLE]]` → `[[EAGLE-3|EAGLE]]` |

### 失效 `[[链接]]` 重写说明

默认开启。当一篇笔记被删除、但其名字已作为另一篇笔记的 aliases 时，旧笔记里遗留的 `[[已删除名]]` 链接会失效。扫描时这类链接会被列出，重写为指向别名笔记的形式，并在显示文本中保留原链接目标：

- `[[EAGLE]]` → `[[EAGLE-3|EAGLE]]`
- `[[EAGLE|讲义]]`（带原显示文字） → `[[EAGLE-3|讲义]]`
- `![[EAGLE]]`（嵌入） → `![[EAGLE-3|EAGLE]]`
- `[[EAGLE#0x01 论文]]`（带标题） → `[[EAGLE-3#0x01 论文|EAGLE]]`

仍指向存在笔记的链接不动（不会重复处理）；无法通过别名解析的失效链接（目标既不是笔记名也不是别名）不会处理。

### 行内代码内转链说明

默认开启。当一段行内代码（一对反引号）的**内容与某篇笔记名或别名完全相等**时，按 `Ctrl+Alt+X` 扫描会把它连同反引号一起替换成 `[[笔记名]]`，例如：

- `EagleDraftWorker` → `[[EagleDraftWorker]]`
- `EDW`（某笔记别名） → `[[EagleDraftWorker|EDW]]`

只整段命中才可链：`` `EagleDraftWorkerBase` `` 内的 `EagleDraftWorker` 不会被链；围栏代码块、数学公式、已有链接等区域仍然跳过。不需要时可在设置中关闭该开关。

## 别名写法示例

在某篇笔记（如 `猫.md`）的 frontmatter 中：

```yaml
---
aliases: [小猫, 喵星人]
---
```

之后在任意笔记里写「我家小猫和喵星人」，触发本插件即可把「小猫」「喵星人」转为 `[[猫|小猫]]`、`[[猫|喵星人]]`。

## 开发自测

`utils.ts` 的粘贴区间定位、`linker.ts` 的窗口扫描，以及 `excalidraw.ts` 的写回契约与链接装饰读取（`applyExcalidraw` / `getLinkDecoration` / `ensureZeroLayoutFrontmatter`，用 mock 的 ExcalidrawAutomate 与 mock 的 App）都是纯逻辑，不依赖 Obsidian 运行时，可直接在本地跑断言（共 66 条）：

```bash
npx esbuild test-locate.ts     --bundle --platform=node --format=cjs --outfile=.test/test-locate.cjs && node .test/test-locate.cjs
npx esbuild test-scan.ts       --bundle --platform=node --format=cjs --outfile=.test/test-scan.cjs   && node .test/test-scan.cjs
npx esbuild test-excalidraw.ts --bundle --platform=node --format=esm --alias:obsidian=./obsidian-stub.ts --outfile=.test/test-excalidraw.mjs && node .test/test-excalidraw.mjs
```

（`obsidian-stub.ts` 是给 node 用的 obsidian 运行时替身，仅自测时通过 `--alias` 注入；`npm test` 会依次跑全部三个文件。）

## 目录结构

```
smart-linker/
├── manifest.json      # 插件元数据
├── package.json       # 依赖与构建脚本
├── tsconfig.json
├── esbuild.config.mjs
├── versions.json
├── styles.css         # 弹窗样式
├── main.ts            # 入口：命令 + 热键 + 设置 + 粘贴自动双链（笔记 / 画板）
├── types.ts           # 类型与默认设置
├── utils.ts           # 正则/保护区间/粘贴区间定位等纯函数工具
├── linker.ts          # 建索引 + 扫描匹配 + 应用替换
├── modal.ts           # 候选确认弹窗
├── tag-modal.ts       # 排除标签选择弹窗
├── excalidraw.ts      # Excalidraw 画板：扫描 + ExcalidrawAutomate 写回
├── settings.ts        # 设置页
├── test-locate.ts     # 自测：粘贴区间定位
├── test-scan.ts       # 自测：窗口内扫描与替换
├── test-excalidraw.ts # 自测：画板写回契约（mock EA）
└── obsidian-stub.ts   # 自测用的 obsidian 运行时替身
```

## 许可证

MIT
