import { Editor, MarkdownView, Notice, Plugin, type TFile } from "obsidian";
import { DEFAULT_SETTINGS, type SmartLinkerSettings } from "./types";
import { applyReplacements, buildReplacements, scan } from "./linker";
import { applyExcalidraw, getActiveExcalidrawView, scanExcalidraw } from "./excalidraw";
import { LinkSuggestModal } from "./modal";
import { SmartLinkerSettingTab } from "./settings";

export default class SmartLinkerPlugin extends Plugin {
	settings: SmartLinkerSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "smart-link-suggest",
			name: "智能链接已有笔记",
			callback: () => {
				this.runLinker();
			},
			hotkeys: [{ modifiers: ["Mod", "Alt"], key: "x" }],
		});

		this.addSettingTab(new SmartLinkerSettingTab(this.app, this));
	}

	/** 根据当前激活视图分流：Markdown 编辑器或 Excalidraw 画板。 */
	private runLinker(): void {
		const md = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (md) {
			this.runMarkdown(md.editor, md.file);
			return;
		}
		if (getActiveExcalidrawView(this.app)) {
			this.runExcalidraw();
			return;
		}
		new Notice("请在 Markdown 笔记或 Excalidraw 画板中使用本命令");
	}

	private runMarkdown(editor: Editor, file: TFile | null): void {
		const res = scan(this.app, editor, file, this.settings);
		if (res.candidates.length === 0) {
			new Notice("未发现可链接的词（没有匹配到已有笔记名或别名）");
			return;
		}
		new LinkSuggestModal(this.app, res.candidates, {
			previewLink: (c, i) => buildReplacements(res.text, c, i)[0]?.text ?? "",
			onApply: (sels) => {
				const reps = sels.flatMap((s) => buildReplacements(res.text, s.candidate, s.targetIndex));
				if (reps.length === 0) {
					new Notice("未选择任何链接");
					return;
				}
				applyReplacements(editor, reps);
				new Notice(`已创建 ${reps.length} 处双链`);
			},
		}).open();
	}

	private runExcalidraw(): void {
		const res = scanExcalidraw(this.app, this.settings);
		if (!res) {
			new Notice("未找到 Excalidraw 脚本 API（请确认 Excalidraw 插件已启用并打开了画板）");
			return;
		}
		if (res.candidates.length === 0) {
			new Notice("未发现可链接的文本元素");
			return;
		}
		new LinkSuggestModal(this.app, res.candidates, {
			subtitle: `发现 ${res.candidates.length} 个可链接项（Excalidraw）。会把所选文字替换为 [[双链]]。`,
			previewLink: (c, i) => {
				const src = c.source as { text?: string } | undefined;
				return buildReplacements(src?.text ?? c.text, c, i)[0]?.text ?? "";
			},
			onApply: (sels) => {
				try {
					const n = applyExcalidraw(res.ea, sels);
					new Notice(n > 0 ? `已链接 ${n} 个 Excalidraw 文本元素` : "未选择任何项");
				} catch (e) {
					new Notice(`应用失败：${String(e)}`);
				}
			},
		}).open();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
