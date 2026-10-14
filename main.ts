import { Editor, ItemView, MarkdownView, Notice, Plugin, type MarkdownFileInfo, type TFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	type CandidateSelection,
	type MatchCandidate,
	type SmartLinkerSettings,
} from "./types";
import { applyReplacements, buildIndex, buildReplacements, scan, scanText } from "./linker";
import {
	applyExcalidraw,
	elementRawText,
	ensureZeroLayoutFrontmatter,
	getActiveExcalidrawView,
	getExcalidrawAutomate,
	getLinkDecoration,
	isEditingTextInView,
	scanExcalidraw,
	type ExcalidrawApi,
	type ExcalidrawElement,
	type ExcalidrawSource,
} from "./excalidraw";
import { LinkSuggestModal } from "./modal";
import { SmartLinkerSettingTab } from "./settings";
import { countLines, firstMeaningfulLine, locateInsertedRange, snippetMatches, type Range } from "./utils";

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

		// Excalidraw 画板没有 editor-paste 事件，改在 DOM 层捕获粘贴后轮询场景变化。
		this.registerDomEvent(
			this.app.workspace.containerEl,
			"paste",
			(evt: ClipboardEvent) => this.onExcalidrawPaste(evt),
			{ capture: true },
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

	/** Excalidraw 画板：候选预览与写回都走 ExcalidrawAutomate。 */
	private runExcalidraw(): void {
		const res = scanExcalidraw(this.app, this.settings);
		if (!res) {
			new Notice("未找到 Excalidraw 画板（请确认 Excalidraw 插件已启用并打开了画板）");
			return;
		}
		if (res.candidates.length === 0) {
			new Notice(
				res.selectedOnly
					? "选中的元素里没有可链接的词"
					: `未发现可链接的词（已扫描 ${res.elementCount} 个文本元素）`,
			);
			return;
		}
		const forceAlias = this.settings.eaAliasAlways;
		new LinkSuggestModal(this.app, res.candidates, {
			subtitle: `发现 ${res.candidates.length} 个可链接词（Excalidraw${
				res.selectedOnly ? " · 仅选中元素" : ` · ${res.elementCount} 个文本元素`
			}）。写入 ${forceAlias ? "[[笔记名|原文]]" : "[[双链]]"}，画布文字内容不变。`,
			previewLink: (c, i) => {
				const src = c.source as { text?: string } | undefined;
				return buildReplacements(src?.text ?? c.text, c, i, { forceAlias, escapeTable: false })[0]?.text ?? "";
			},
			onApply: (sels) => {
				void this.applyExcalidrawSelections(res.ea, sels);
			},
		}).open();
	}

	/** Excalidraw 写回 + 提示（手动与自动共用）。 */
	private async applyExcalidrawSelections(ea: ExcalidrawApi, sels: CandidateSelection[]): Promise<void> {
		try {
			const n = await applyExcalidraw(ea, sels, { forceAlias: this.settings.eaAliasAlways });
			const hint = n > 0 ? await this.linkDecorationHint(ea) : "";
			if (!this.settings.autoLinkShowNotice) return;
			new Notice(n > 0 ? `已给 ${n} 个 Excalidraw 文本元素建链（Ctrl+Z 可撤销）${hint}` : "没有可写入的改动");
		} catch (e) {
			new Notice(`Excalidraw 写入失败：${String(e)}`);
		}
	}

	/** 当前画板对应的文件（用于读写 frontmatter、判断装饰设置）。 */
	private excalidrawFile(ea: ExcalidrawApi): TFile | null {
		const v = ea.targetView as (ItemView & { file?: TFile | null }) | undefined;
		return v?.file ?? null;
	}

	/**
	 * 链接装饰（📍 前缀 / [[ ]] 方括号）的处理与提示。
	 * - 开启「排版零变化」：给画板写 frontmatter 关掉装饰，返回「需重开画板」的提示
	 * - 未开启：若装饰开着，提示画布上会多出这些符号、以及怎么做到完全不变
	 */
	private async linkDecorationHint(ea: ExcalidrawApi): Promise<string> {
		try {
			const file = this.excalidrawFile(ea);
			if (this.settings.eaZeroLayout) {
				if (!file) return "";
				const changed = await ensureZeroLayoutFrontmatter(this.app, file);
				return changed ? "（已为该画板关闭链接装饰，重开画板后生效）" : "";
			}
			const dec = getLinkDecoration(this.app, file);
			if (!dec.brackets && dec.prefix === "") return "";
			const marks = `${dec.prefix}${dec.brackets ? "[[]]" : ""}`;
			return `（画布上链接会显示成「${marks}…」，要排版完全不变可开启「排版零变化」）`;
		} catch {
			return "";
		}
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

	// ───────────────── Excalidraw 画板：粘贴自动双链 ─────────────────

	/**
	 * 画板粘贴入口。Excalidraw 没有「粘贴完成」事件，且粘贴在画布上（新建文本元素）
	 * 与在文本框内编辑（提交后才落到元素上）时序不同，因此统一用轮询比对场景变化：
	 * 找到「新增的 / 内容变化且包含粘贴片段」的文本元素，等编辑结束后自动建链，只处理一次。
	 */
	private onExcalidrawPaste(evt: ClipboardEvent): void {
		const s = this.settings;
		if (!s.autoLinkOnPaste || !s.autoLinkExcalidrawOnPaste) return;

		const target = evt.target as Node | null;
		const view = getActiveExcalidrawView(this.app);
		if (!view || !target || !view.containerEl.contains(target)) return;

		const raw = evt.clipboardData?.getData("text/plain") ?? "";
		if (raw.trim() === "" || countLines(raw) <= s.autoLinkMinLines) return;

		const ea = getExcalidrawAutomate(this.app, view);
		if (!ea) return;

		const before = this.snapshotTextElements(ea);
		const snippet = firstMeaningfulLine(raw);
		if (snippet === "") return;

		let tries = 0;
		const timer = window.setInterval(() => {
			tries++;
			if (tries > 40 || !view.containerEl.isConnected) {
				window.clearInterval(timer);
				return;
			}
			// 还在文本框里编辑 → 等提交后再处理，避免和 Excalidraw 的文本编辑器打架
			if (isEditingTextInView(view)) return;

			const changed = this.findPastedElements(ea, before, snippet, s.autoLinkMinLines);
			if (changed.length === 0) return;
			window.clearInterval(timer);
			void this.autoLinkExcalidrawElements(ea, changed);
		}, 400);
	}

	/** 记录当前画板所有文本元素的原文（id → 原文），用于识别粘贴后变化了哪些元素。 */
	private snapshotTextElements(ea: ExcalidrawApi): Map<string, string> {
		const map = new Map<string, string>();
		try {
			for (const el of ea.getViewElements() ?? []) {
				if (el?.type === "text" && !el.isDeleted) map.set(el.id, elementRawText(el));
			}
		} catch {
			/* 忽略：拿不到场景时按空快照处理 */
		}
		return map;
	}

	/** 找出因本次粘贴而出现/改变的文本元素：新增、或原文变化且包含粘贴片段、且行数达标。 */
	private findPastedElements(
		ea: ExcalidrawApi,
		before: Map<string, string>,
		snippet: string,
		minLines: number,
	): ExcalidrawElement[] {
		let elements: ExcalidrawElement[] = [];
		try {
			elements = ea.getViewElements() ?? [];
		} catch {
			return [];
		}
		const out: ExcalidrawElement[] = [];
		for (const el of elements) {
			if (el?.type !== "text" || el.isDeleted || !el.id) continue;
			const text = elementRawText(el);
			if (text === "" || countLines(text) <= minLines) continue;
			const old = before.get(el.id);
			if (old !== undefined && old === text) continue; // 没变化
			if (!snippetMatches(text, snippet)) continue;
			out.push(el);
		}
		return out;
	}

	/** 对粘贴产生的 Excalidraw 文本元素自动建链（默认目标、可选跳过歧义词）。 */
	private async autoLinkExcalidrawElements(ea: ExcalidrawApi, elements: ExcalidrawElement[]): Promise<void> {
		const s = this.settings;
		const file = (ea.targetView as (ItemView & { file?: TFile | null }) | undefined)?.file ?? null;
		const index = buildIndex(this.app, s, file ? ({ path: file.path } as never) : null);

		let candidates: MatchCandidate[] = [];
		for (const el of elements) {
			const text = elementRawText(el);
			const found = scanText(text, index, s, {
				protect: s.protectSpecialRanges,
				source: { element: el, text } satisfies ExcalidrawSource,
			});
			candidates.push(...found);
		}
		if (s.autoLinkSkipAmbiguous) candidates = candidates.filter((c) => c.targets.length === 1);
		if (candidates.length === 0) {
			if (s.autoLinkShowNotice) {
				new Notice(`画板粘贴内容超过 ${s.autoLinkMinLines} 行，但未发现可链接的词`);
			}
			return;
		}

		if (s.autoLinkMode === "confirm") {
			const forceAlias = s.eaAliasAlways;
			new LinkSuggestModal(this.app, candidates, {
				subtitle: `画板粘贴自动双链 · ${candidates.length} 个词待确认`,
				previewLink: (c, i) => {
					const src = c.source as { text?: string } | undefined;
					return buildReplacements(src?.text ?? c.text, c, i, { forceAlias, escapeTable: false })[0]?.text ?? "";
				},
				onApply: (sels) => {
					void this.applyExcalidrawSelections(ea, sels);
				},
			}).open();
			return;
		}

		const sels: CandidateSelection[] = candidates.map((c) => ({
			candidate: c,
			targetIndex: c.defaultTargetIndex,
		}));
		const n = await applyExcalidraw(ea, sels, { forceAlias: s.eaAliasAlways });
		if (n <= 0) return;
		const hint = await this.linkDecorationHint(ea);
		if (s.autoLinkShowNotice) {
			new Notice(`画板粘贴自动双链：${n} 个文本元素（Ctrl+Z 可撤销）${hint}`);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
