import { Editor, MarkdownView, Notice, Plugin, type MarkdownFileInfo, type TFile } from "obsidian";
import { DEFAULT_SETTINGS, type MatchCandidate, type SmartLinkerSettings } from "./types";
import { applyReplacements, buildIndex, buildReplacements, scan, scanText } from "./linker";
import { applyExcalidraw, getActiveExcalidrawView, scanExcalidraw } from "./excalidraw";
import { LinkSuggestModal } from "./modal";
import { SmartLinkerSettingTab } from "./settings";
import { countLines, locateInsertedRange, type Range } from "./utils";

export default class SmartLinkerPlugin extends Plugin {
	settings: SmartLinkerSettings = DEFAULT_SETTINGS;
	/** 防重入：同一次粘贴只处理一次，处理未结束时忽略新的粘贴触发。 */
	private pasteAutoBusy = false;

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

		this.addCommand({
			id: "smart-link-toggle-paste-auto",
			name: "切换：粘贴后自动双链",
			callback: async () => {
				this.settings.autoLinkOnPaste = !this.settings.autoLinkOnPaste;
				await this.saveSettings();
				new Notice(`粘贴后自动双链已${this.settings.autoLinkOnPaste ? "开启" : "关闭"}`);
			},
		});

		this.addCommand({
			id: "smart-link-reload-self",
			name: "重新加载本插件（改完代码后用）",
			callback: async () => {
				// 用内部 API 关再开来热重载，免重启 Obsidian
				const pm = (this.app as unknown as {
					plugins?: { disablePlugin: (id: string) => Promise<void>; enablePlugin: (id: string) => Promise<void> };
				}).plugins;
				if (!pm) {
					new Notice("无法访问插件管理器，请手动在设置中关闭再开启本插件");
					return;
				}
				const id = this.manifest.id;
				await pm.disablePlugin(id);
				await pm.enablePlugin(id);
				new Notice("智能双链助手已重新加载");
			},
		});

		// 粘贴后自动双链：粘贴内容的行数超过阈值时，自动扫描并建链，无需手动按快捷键。
		this.registerEvent(
			this.app.workspace.on("editor-paste", (evt: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				this.onEditorPaste(evt, editor, info);
			}),
		);

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
		this.showModal(editor, res.candidates, res.text);
	}

	/** 打开候选确认弹窗（手动命令与「自动双链的确认模式」共用）。 */
	private showModal(editor: Editor, candidates: MatchCandidate[], text: string, subtitle?: string): void {
		new LinkSuggestModal(this.app, candidates, {
			subtitle,
			previewLink: (c, i) => buildReplacements(text, c, i)[0]?.text ?? "",
			onApply: (sels) => {
				const reps = sels.flatMap((s) => buildReplacements(text, s.candidate, s.targetIndex));
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

	// ───────────────────────── 粘贴后自动双链 ─────────────────────────

	/** 粘贴事件入口：只做「是否值得处理」的判断，实际建链延后到粘贴落盘之后。 */
	private onEditorPaste(evt: ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
		const s = this.settings;
		if (!s.autoLinkOnPaste || this.pasteAutoBusy) return;

		const raw = evt.clipboardData?.getData("text/plain") ?? "";
		if (raw.trim() === "") return;
		// 行数严格大于阈值才触发（默认 5 → 6 行及以上）
		if (countLines(raw) <= s.autoLinkMinLines) return;

		let before = "";
		let selStart = 0;
		let selLen = 0;
		try {
			before = editor.getValue();
			const sel = editor.listSelections()[0];
			if (sel) {
				const a = editor.posToOffset(sel.anchor);
				const b = editor.posToOffset(sel.head);
				selStart = Math.min(a, b);
				selLen = Math.abs(a - b);
			}
		} catch {
			return;
		}

		const file = info?.file ?? null;
		const stop = (): void => {
			this.pasteAutoBusy = false;
		};
		this.pasteAutoBusy = true;
		// 等编辑器把粘贴内容写入文档后再定位并建链
		this.whenPasted(editor, file, before, selStart, selLen, raw, 0, stop);
	}

	/**
	 * 粘贴落盘后定位「本次新增的区间」并建链。
	 * 定位策略（依次尝试）：① 在新文本中就近找到粘贴原文；② 前缀/后缀 diff 求出变更区间。
	 * 首次尝试可能早于编辑器提交，故带少量重试。
	 */
	private whenPasted(
		editor: Editor,
		file: TFile | null,
		before: string,
		selStart: number,
		selLen: number,
		raw: string,
		attempt: number,
		stop: () => void,
	): void {
		window.setTimeout(() => {
			// 期间若已切换到别的笔记/编辑器，放弃处理，避免链错文档
			const active = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!active || active.editor !== editor) {
				stop();
				return;
			}
			let after: string;
			try {
				after = editor.getValue();
			} catch {
				stop();
				return;
			}

			const range = locateInsertedRange(before, after, selStart, selLen, raw);
			if (!range) {
				// 文档尚未更新（粘贴是异步的）→ 稍后重试
				if (attempt < 4) {
					this.whenPasted(editor, file, before, selStart, selLen, raw, attempt + 1, stop);
					return;
				}
				stop();
				return;
			}
			try {
				this.autoLinkRange(editor, after, file, range);
			} finally {
				stop();
			}
		}, attempt === 0 ? 0 : 40);
	}

	/** 在指定区间内扫描并落地链接。 */
	private autoLinkRange(editor: Editor, text: string, file: TFile | null, range: Range): void {
		const s = this.settings;
		const win: Range =
			s.autoLinkScope === "note"
				? [0, text.length]
				: [Math.max(0, Math.min(range[0], text.length)), Math.max(0, Math.min(range[1], text.length))];
		if (win[1] <= win[0]) return;

		const index = buildIndex(this.app, s, file);
		let candidates = scanText(text, index, s, { window: win, protect: s.protectSpecialRanges });
		if (s.autoLinkSkipAmbiguous) candidates = candidates.filter((c) => c.targets.length === 1);

		if (candidates.length === 0) {
			if (s.autoLinkShowNotice) {
				new Notice(`粘贴内容超过 ${s.autoLinkMinLines} 行，但未发现可链接的词`);
			}
			return;
		}

		// 确认模式：把自动发现的候选交给用户勾选
		if (s.autoLinkMode === "confirm") {
			this.showModal(editor, candidates, text, `粘贴自动双链 · ${candidates.length} 个词待确认`);
			return;
		}

		// 直接应用：每个词用默认目标（优先笔记名本身）
		const reps = candidates.flatMap((c) => buildReplacements(text, c, c.defaultTargetIndex));
		if (reps.length === 0) return;
		applyReplacements(editor, reps);
		if (s.autoLinkShowNotice) {
			new Notice(`粘贴自动双链：${reps.length} 处 · ${candidates.length} 个词（Ctrl+Z 可撤销）`);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
