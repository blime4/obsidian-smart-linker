# 智能双链助手 (Smart Linker)

一个 Obsidian 插件：按下快捷键扫描当前笔记，找出其中「恰好对应某篇已有笔记名或别名（aliases）」的词，弹窗让你勾选，一键把它们原地转成 `[[]]` 双链。帮助你快速把分散的文字与已有知识库连起来。

- 支持笔记名 **和** 别名（aliases）
- 别名链接形式为 `[[笔记名|显示文字]]`，保留原文显示
- 自动跳过代码块、行内代码、数学公式、已有 `[[链接]]`、Markdown 链接、HTML 标签
- 中文友好（按字面匹配），拉丁字母可选整词匹配；复合词（如 `Chunked-prefill`、`auto_link`）视为整体，不会拆出子词
- 同一词匹配多篇笔记时可在下拉框选择目标
- **同时支持 Markdown 笔记和 Excalidraw 画板**
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
4. 开发期间可执行 `npm run dev` 进入监听模式，保存 `.ts` 后自动重新打包；改完后在 Obsidian 里关闭再开启本插件即可生效（或安装社区插件 *Hot-Reload* 自动热重载）。

## 使用方法

1. 打开任意一篇 **Markdown 笔记** 或 **Excalidraw 画板**。
2. 按 **`Ctrl+Alt+X`**（Mac 为 **`Cmd+Alt+X`**）。
   - Markdown：若选中了一段文字，只扫描选中部分；否则扫描整篇笔记。
   - Excalidraw：扫描当前画板的所有文本元素。
3. 弹窗会列出所有命中的词：
   - 每行 = 复选框 + 命中词 → 目标笔记 + 出现次数 + 预览双链。
   - 多目标时用下拉框选择。
   - 「全选 / 反选」批量勾选；底部按钮显示将创建的链接数。
4. 点 **链接** 即可批量转为双链；Markdown 模式下 `Ctrl+Z` 可一次撤销。

### Excalidraw 说明

- 在 Excalidraw 画板中按快捷键，会把文本元素里匹配的词替换为 `[[双链]]`（与 Markdown 同样的写法）。
- 依赖 Excalidraw 插件对外暴露的脚本 API（`view.excalidrawAPI`）。
- 若替换后链接显示为字面的 `[[…]]` 而非可点击链接，请在 Excalidraw 插件设置中开启 **「Sync element link with text / 同步元素链接与文本」**，并按需关闭「显示链接括号」。
- 该功能在不同 Excalidraw 插件版本/分支上行为可能略有差异；如遇问题请反馈。

### 复合词规则

`Chunked-prefill`、`auto_link`、`category` 这类连续字母数字串（含连字符、下划线）会被视为一个整体词，因此笔记名 `prefill` 不会匹配到 `Chunked-prefill` 内部的 `prefill`。中文按字面匹配，不受此影响。

## 修改快捷键

默认 `Ctrl+Alt+X`。如需修改：

**设置 → 快捷键**，搜索命令「**智能链接已有笔记**」，点后面的按钮录入新快捷键。

## 设置项

| 设置 | 默认 | 说明 |
|------|------|------|
| 最小词长度 | 2 | 短于此长度的笔记名/别名不���与匹配 |
| 包含笔记名 | 开 | 把笔记文件名作为可链接词 |
| 包含别名（aliases） | 开 | 把 frontmatter aliases 作为可链接词 |
| 排除当前笔记自身 | 开 | 不把当前笔记自身作为链接目标 |
| 排除标签（tags） | 空 | 带这些标签的笔记不作为链接目标，逗号分隔，支持层级（如 `private` 同时排除 `#private/工作`） |
| 区分大小写 | 关 | 关闭时 Cat/cat 视作相同并保留原文大小写 |
| 拉丁字母整词匹配 | 开 | `cat` 不会匹配 `category` 内部；中文不受影响 |
| 跳过特殊区域 | 开 | 不在代码块/公式/已有链接等区域创建链接 |

## 别名写法示例

在某篇笔记（如 `猫.md`）的 frontmatter 中：

```yaml
---
aliases: [小猫, 喵星人]
---
```

之后在任意笔记里写「我家小猫和喵星人」，触发本插件即可把「小猫」「喵星人」转为 `[[猫|小猫]]`、`[[猫|喵星人]]`。

## 目录结构

```
smart-linker/
├── manifest.json     # 插件元数据
├── package.json      # 依赖与构建脚本
├── tsconfig.json
├── esbuild.config.mjs
├── versions.json
├── styles.css        # 弹窗样式
├── main.ts           # 入口：命令 + 热键 + 设置
├── types.ts          # 类型与默认设置
├── utils.ts          # 正则/保护区间/工具函数
├── linker.ts         # 建索引 + 扫描匹配 + 应用替换
├── modal.ts          # 候选确认弹窗
└── settings.ts       # 设置页
```

## 许可证

MIT
