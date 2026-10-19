import type { App } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./types";
import type SmartLinkerPlugin from "./main";
import { TagSelectModal } from "./tag-modal";
import { findExcalidrawPlugin, getLinkDecoration } from "./excalidraw";

/** 插件设置页（中文）。 */
export class SmartLinkerSettingTab extends PluginSettingTab {
	private readonly plugin: SmartLinkerPlugin;

	constructor(app: App, plugin: SmartLinkerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("快捷键").setHeading();
		new Setting(containerEl)
			.setName("触发命令的快捷键")
			.setDesc('默认 Ctrl+Alt+X（Mac 为 Cmd+Alt+X）。如需修改，请到「设置 → 快捷键」中搜索命令「智能链接已有笔记」。')
			.addExtraButton((b) => {
				b.setIcon("switch").setTooltip("打开快捷键设置").onClick(() => {
					try {
						const setting = (this.app as unknown as {
							setting?: { open: () => void; openTabById: (id: string) => void };
						}).setting;
						setting?.open();
						setting?.openTabById("hotkeys");
					} catch {
						// 忽略：用户可手动打开「设置 → 快捷键」
					}
				});
			});

		new Setting(containerEl).setName("粘贴自动双链").setHeading();
		new Setting(containerEl)
			.setName("粘贴后自动双链")
			.setDesc(
				`开启后，粘贴进笔记的内容行数超过下方阈值时，会自动扫描并把命中的笔记名/别名转为 [[双链]]，无需再按快捷键。可在「快捷键」中给命令「切换：粘贴后自动双链」绑定一个开关热键。（当前${s.autoLinkOnPaste ? "已开启" : "已关闭"}）`,
			)
			.addToggle((t) => t.setValue(s.autoLinkOnPaste).onChange(async (v) => { s.autoLinkOnPaste = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("触发行数")
			.setDesc("粘贴内容的行数「严格大于」该值时才触发自动双链。默认 5，即粘贴 6 行及以上触发。")
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(s.autoLinkMinLines));
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					s.autoLinkMinLines = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.autoLinkMinLines;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("处理范围")
			.setDesc("「只处理粘贴内容」更安全，只给本次粘贴进来的文字建链；「整篇笔记」会连同笔记里其余文字一起建链。")
			.addDropdown((d) =>
				d
					.addOption("pasted", "只处理粘贴的内容")
					.addOption("note", "整篇笔记")
					.setValue(s.autoLinkScope)
					.onChange(async (v) => {
						s.autoLinkScope = v === "note" ? "note" : "pasted";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("落地方式")
			.setDesc("「直接写入」按默认目标静默建链（一次 Ctrl+Z 可整体撤销）；「弹窗确认」会先弹出候选列表让你勾选。")
			.addDropdown((d) =>
				d
					.addOption("apply", "直接写入")
					.addOption("confirm", "弹窗确认")
					.setValue(s.autoLinkMode)
					.onChange(async (v) => {
						s.autoLinkMode = v === "confirm" ? "confirm" : "apply";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("跳过歧义词")
			.setDesc("某个词同时对应多篇笔记时不自动建链，留给手动触发处理，避免链错目标。")
			.addToggle((t) => t.setValue(s.autoLinkSkipAmbiguous).onChange(async (v) => { s.autoLinkSkipAmbiguous = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("显示结果提示")
			.setDesc("自动建链后弹出提示，告知创建了多少处链接。")
			.addToggle((t) => t.setValue(s.autoLinkShowNotice).onChange(async (v) => { s.autoLinkShowNotice = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Excalidraw 画板：粘贴后自动双链")
			.setDesc("在 Excalidraw 画板上粘贴超过阈值的多行文本时也自动建链（含粘贴后在文本框里编辑、提交生效的情况）。需上方「粘贴后自动双链」总开关为开。")
			.addToggle((t) => t.setValue(s.autoLinkExcalidrawOnPaste).onChange(async (v) => { s.autoLinkExcalidrawOnPaste = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("粘贴带图片时跳过（推荐开启）")
			.setDesc(
				[
					"粘贴内容里含图片/文件时，交回给 Excalidraw 自己插入，本插件不介入。",
					"原因：本插件的写回会用「开始写之前的整份画板快照」整体覆盖，若此刻 Excalidraw 正在把图片放进画板，图片会被冲掉（表现为「插入图片失败」或图片一闪就没了）。",
					"关闭后，带图片的粘贴也会尝试自动双链，插入图片可能因此失败。",
				].join("\n"),
			)
			.addToggle((t) => t.setValue(s.autoLinkSkipImagePaste).onChange(async (v) => { s.autoLinkSkipImagePaste = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName("Excalidraw 画板").setHeading();

		new Setting(containerEl)
			.setName("总是写入 [[笔记名|原文]]")
			.setDesc(
				"开启（推荐）：双链的显示文字取「原文」，画布文字不会变成笔记名。关闭：同名词写成 [[笔记名]]，画布文字会变成笔记名。",
			)
			.addToggle((t) => t.setValue(s.eaAliasAlways).onChange(async (v) => { s.eaAliasAlways = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("排版零变化（关闭画板上的链接装饰）")
			.setDesc(
				[
					"开启后，写链时会自动给该画板写入 frontmatter：excalidraw-link-brackets: false 与 excalidraw-link-prefix: \"\"。",
					"效果：画布上的文字与文本框尺寸在加链接前后完全一致（真正意义上的排版零变化），链接只在底层生效。",
					"代价：会同时去掉该画板上所有已有链接的 📍 与 [[]] 装饰（因为装饰是画板级设置，不是逐条链接设置）。需重开该画板才生效。",
					"默认关闭（Excalidraw 自己的装饰设置原样保留）。这两个键是 Excalidraw 官方的按画板覆盖项，你也可以手动写进画板 frontmatter。",
				].join("\n"),
			)
			.addToggle((t) => t.setValue(s.eaZeroLayout).onChange(async (v) => { s.eaZeroLayout = v; await this.plugin.saveSettings(); }));

		// 读取 Excalidraw 插件自身的相关设置 + 当前画板的 frontmatter 覆盖，给出准确的状态提示（只读，不修改别人的设置）
		const ex = findExcalidrawPlugin(this.app);
		if (ex) {
			const sync = ex.settings?.syncElementLinkWithText;
			const activeFile = this.app.workspace.getActiveFile();
			const dec = getLinkDecoration(this.app, activeFile);
			const decoOn = dec.brackets || dec.prefix !== "";
			const scope = dec.source === "frontmatter" ? `（来自 ${activeFile?.name ?? "当前画板"} 的 frontmatter 覆盖）` : "（来自 Excalidraw 全局设置）";
			const info = new Setting(containerEl)
				.setName("Excalidraw 插件设置检查")
				.setDesc(
					[
						`链接装饰的当前生效值${scope}：方括号 [[ ]] ${dec.brackets ? "开" : "关"} · 前缀 ${dec.prefix === "" ? "无" : `「${dec.prefix}」`}。`,
						decoOn
							? "⚠️ 装饰是开启的，所以文字变成链接后画布上会多出这些符号（文本框会略微变宽）。这是 Excalidraw 自身的渲染行为。想要画布完全不变，请开启上方「排版零变化」，或在 Excalidraw 设置里把「Show [[brackets]] around links」关掉、把「Link prefix」清空。"
							: "✅ 装饰已全部关闭：`[[笔记名|原文]]` 在画布上的显示文字恰好等于原文，加链接前后排版完全一致。",
						`同步元素链接与文本（syncElementLinkWithText）：${sync ? "开" : "关"} —— 开启后文本里的第一个 [[链接]] 会同步到元素本身，整块图形可点击。`,
						"画布上 Ctrl+单击带 [[链接]] 的文字即可跳转。",
					].join("\n"),
				)
				.addExtraButton((b) => {
					b.setIcon("switch").setTooltip("打开 Excalidraw 插件设置").onClick(() => {
						try {
							const setting = (this.app as unknown as {
								setting?: { open: () => void; openTabById: (id: string) => void };
							}).setting;
							setting?.open();
							if (ex.id) setting?.openTabById(ex.id);
						} catch {
							// 忽略：用户可手动打开 Excalidraw 设置
						}
					});
				});
			info.descEl.style.whiteSpace = "pre-line";
		}

		new Setting(containerEl).setName("匹配范围").setHeading();
		new Setting(containerEl)
			.setName("扫描范围")
			.setDesc("选中文字时只扫描选中部分；未选中时扫描整篇当前笔记。");

		new Setting(containerEl).setName("匹配规则").setHeading();
		new Setting(containerEl)
			.setName("最小词长度")
			.setDesc("短于此长度的笔记名/别名不参与匹配，避免误链单字。")
			.addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(s.minTermLength));
				t.onChange(async (v) => {
					const n = parseInt(v, 10);
					s.minTermLength = Number.isFinite(n) && n >= 1 ? n : DEFAULT_SETTINGS.minTermLength;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("包含笔记名")
			.setDesc("把每篇笔记的文件名作为可链接词。")
			.addToggle((t) => t.setValue(s.includeNoteNames).onChange(async (v) => { s.includeNoteNames = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("包含别名（aliases）")
			.setDesc("把 frontmatter 中的 aliases 也作为可链接词，链接形式为 [[笔记|别名]]。")
			.addToggle((t) => t.setValue(s.includeAliases).onChange(async (v) => { s.includeAliases = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("排除当前笔记自身")
			.setDesc("不把当前正在编辑的笔记名/别名作为链接目标。")
			.addToggle((t) => t.setValue(s.excludeCurrentNote).onChange(async (v) => { s.excludeCurrentNote = v; await this.plugin.saveSettings(); }));

		const tagSetting = new Setting(containerEl)
			.setName("排除标签（tags）")
			.setDesc("带这些标签的笔记不作为链接目标。支持层级前缀，如 private 会同时排除 #private 与 #private/工作。");

		const tagChipBar = tagSetting.descEl.parentElement!.createDiv();
		tagChipBar.style.marginTop = "8px";
		tagChipBar.style.display = "flex";
		tagChipBar.style.flexWrap = "wrap";
		tagChipBar.style.gap = "4px";
		tagChipBar.style.alignItems = "center";

		const renderChips = (): void => {
			tagChipBar.empty();
			for (const t of s.excludedTags) {
				const chip = tagChipBar.createEl("span");
				chip.setText(`#${t}`);
				chip.style.cssText =
					"display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;font-size:var(--font-ui-smaller);background:var(--tag-bg);color:var(--tag-color);";
				const x = chip.createEl("span");
				x.setText("×");
				x.style.cssText = "cursor:pointer;font-weight:bold;opacity:.6;";
				x.addEventListener("click", async () => {
					s.excludedTags = s.excludedTags.filter((e) => e !== t);
					await this.plugin.saveSettings();
					renderChips();
				});
			}
			const addBtn = tagChipBar.createEl("button");
			addBtn.setText("+ 选择标签");
			addBtn.style.cssText = "font-size:var(--font-ui-smaller);padding:2px 10px;";
			addBtn.addEventListener("click", () => {
				new TagSelectModal(this.app, s.excludedTags, async (tags) => {
					s.excludedTags = tags;
					await this.plugin.saveSettings();
					renderChips();
				}).open();
			});
		};

		renderChips();

		new Setting(containerEl)
			.setName("区分大小写")
			.setDesc("关闭时大小写不敏感（Cat 与 cat 视作相同），并保留原文大小写显示。")
			.addToggle((t) => t.setValue(s.caseSensitive).onChange(async (v) => { s.caseSensitive = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("拉丁字母整词匹配")
			.setDesc("开启时 cat 不会匹配 category 内部；中文不受影响（按字面匹配）。")
			.addToggle((t) => t.setValue(s.wholeWordLatin).onChange(async (v) => { s.wholeWordLatin = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("补全已有双链为最长匹配")
			.setDesc(
				[
					"开启后，已有链接会和紧邻文字合并起来重新匹配，命中更长的词就改写。",
					"例：DFlash.md 的别名里有「DFlash 2」，正文的 [[DFlash]] 2 会被补成 [[DFlash|DFlash 2]]；[[DFlash]]2 会补成 [[DFlash|DFlash2]]。",
					"只改「链接目标不变」的情况：若更长的词指向另一篇笔记，会跳过并在弹窗里标出，不会悄悄改链接去向。",
					"两端可见文字一致，所以渲染出来的文字完全不变，只是链接从半截变成完整词。",
				].join("\n"),
			)
			.addToggle((t) => t.setValue(s.linkExtendToLongest).onChange(async (v) => { s.linkExtendToLongest = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("跳过特殊区域")
			.setDesc("不在代码块、数学公式、已有 [[链接]]、Markdown 链接和 HTML 标签内创建链接（行内代码由下方开关单独控制）。")
			.addToggle((t) => t.setValue(s.protectSpecialRanges).onChange(async (v) => { s.protectSpecialRanges = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("行内代码内转链")
			.setDesc("开启时，`EagleDraftWorker`（反引号内整段等于某笔记名/别名）可连同反引号一起转成 [[EagleDraftWorker]]；代码块与其余特殊区域仍跳过。")
			.addToggle((t) => t.setValue(s.linkInlineCode).onChange(async (v) => { s.linkInlineCode = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("失效 [[链接]] 重写")
			.setDesc("开启时，指向不存在笔记、但命中某笔记别名的 [[链接]] 会被列出并重写，如 [[EAGLE]] → [[EAGLE-3|EAGLE]]。")
			.addToggle((t) => t.setValue(s.fixBrokenLinks).onChange(async (v) => { s.fixBrokenLinks = v; await this.plugin.saveSettings(); }));
	}
}
