import type { App } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS } from "./types";
import type SmartLinkerPlugin from "./main";

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

		new Setting(containerEl)
			.setName("排除标签（tags）")
			.setDesc("带这些标签的笔记不作为链接目标，多个用逗号分隔。支持层级前缀，如填 private 会同时排除 #private 与 #private/工作。")
			.addText((t) => {
				t.setPlaceholder("例如：private, secret");
				t.setValue(s.excludedTags.join(", "));
				t.onChange(async (v) => {
					s.excludedTags = v
						.split(",")
						.map((x) => x.trim().replace(/^#/, ""))
						.filter((x) => x !== "");
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("区分大小写")
			.setDesc("关闭时大小写不敏感（Cat 与 cat 视作相同），并保留原文大小写显示。")
			.addToggle((t) => t.setValue(s.caseSensitive).onChange(async (v) => { s.caseSensitive = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("拉丁字母整词匹配")
			.setDesc("开启时 cat 不会匹配 category 内部；中文不受影响（按字面匹配）。")
			.addToggle((t) => t.setValue(s.wholeWordLatin).onChange(async (v) => { s.wholeWordLatin = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("跳过特殊区域")
			.setDesc("不在代码块、行内代码、数学公式、已有 [[链接]]、Markdown 链接和 HTML 标签内创建链接。")
			.addToggle((t) => t.setValue(s.protectSpecialRanges).onChange(async (v) => { s.protectSpecialRanges = v; await this.plugin.saveSettings(); }));
	}
}
