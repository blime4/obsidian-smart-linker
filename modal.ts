import type { App } from "obsidian";
import { Modal } from "obsidian";
import type { CandidateSelection, MatchCandidate } from "./types";

/** 弹窗选项：预览链接文本 + 应用回调（由调用方决定如何写入）。 */
export interface LinkSuggestModalOptions {
	subtitle?: string;
	/** 根据候选 + 选定目标，返回将生成的链接文本（用于预览）。 */
	previewLink: (candidate: MatchCandidate, targetIndex: number) => string;
	/** 用户确认后，传回所有选中的条目。 */
	onApply: (selections: CandidateSelection[]) => void;
}

/** 候选链接确认弹窗：单行紧凑布局，预览内联。 */
export class LinkSuggestModal extends Modal {
	private readonly candidates: MatchCandidate[];
	private readonly options: LinkSuggestModalOptions;
	private readonly selected: boolean[];
	private readonly chosenTarget: number[];
	private applyBtn: HTMLButtonElement | null = null;

	constructor(app: App, candidates: MatchCandidate[], options: LinkSuggestModalOptions) {
		super(app);
		this.candidates = candidates;
		this.options = options;
		this.selected = candidates.map(() => true);
		this.chosenTarget = candidates.map((c) => c.defaultTargetIndex);
	}

	onOpen(): void {
		this.titleEl.setText("智能双链助手");
		this.modalEl.addClass("smart-linker-modal");

		const { contentEl } = this;
		contentEl.empty();

		const totalOcc = this.candidates.reduce((s, c) => s + c.occurrences.length, 0);
		const sub = contentEl.createEl("div", { cls: "smart-linker-subtitle" });
		sub.setText(
			this.options.subtitle ??
				`发现 ${totalOcc} 处可链接文字 · ${this.candidates.length} 个词`,
		);

		const listEl = contentEl.createEl("div", { cls: "smart-linker-list" });

		const refreshFooter = (): void => {
			if (!this.applyBtn) return;
			let n = 0;
			for (let i = 0; i < this.candidates.length; i++) {
				if (this.selected[i]) n += this.candidates[i].occurrences.length || 1;
			}
			this.applyBtn.setText(`链接 ${n}`);
		};

		this.candidates.forEach((cand, i) => {
			const row = listEl.createDiv({ cls: "smart-linker-row" });

			const cb = row.createEl("input", { type: "checkbox" });
			cb.checked = this.selected[i];
			cb.addEventListener("change", () => {
				this.selected[i] = cb.checked;
				refreshFooter();
			});

			const main = row.createDiv({ cls: "smart-linker-main" });
			main.createSpan({ cls: "smart-linker-term", text: cand.text });
			main.createSpan({ cls: "smart-linker-arrow", text: "→" });

			if (cand.targets.length > 1) {
				const sel = main.createEl("select", { cls: "smart-linker-select" });
				cand.targets.forEach((t, idx) => {
					const opt = sel.createEl("option", { value: String(idx) });
					opt.setText(`${t.noteName}${t.isAlias ? "（别名）" : ""}`);
				});
				sel.value = String(this.chosenTarget[i]);
				sel.addEventListener("change", () => {
					this.chosenTarget[i] = Number(sel.value) || 0;
					previewEl.setText(this.options.previewLink(cand, this.chosenTarget[i]));
				});
			} else {
				const t = cand.targets[0];
				const lbl = main.createSpan({
					cls: "smart-linker-target",
					text: t.noteName + (t.isAlias ? "（别名）" : ""),
				});
				lbl.setAttribute("title", t.file.path);
			}

			const previewEl = row.createEl("span", { cls: "smart-linker-preview" });
			previewEl.setText(this.options.previewLink(cand, this.chosenTarget[i]));
			row.createSpan({ cls: "smart-linker-count", text: `×${cand.occurrences.length || 1}` });
		});

		// 底部按钮区
		const footer = contentEl.createDiv({ cls: "smart-linker-footer" });
		footer.createEl("button", { text: "全选" }).addEventListener("click", () => toggleAll(true));
		footer.createEl("button", { text: "反选" }).addEventListener("click", () => toggleAll(false));
		footer.createDiv({ cls: "smart-linker-spacer" });
		footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		this.applyBtn = footer.createEl("button", { text: "链接", cls: "mod-cta" });
		this.applyBtn.addEventListener("click", () => this.doApply());

		const toggleAll = (value: boolean): void => {
			for (let i = 0; i < this.candidates.length; i++) {
				this.selected[i] = value;
			}
			const boxes = listEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
			boxes.forEach((el, idx) => {
				el.checked = this.selected[idx];
			});
			refreshFooter();
		};

		refreshFooter();
	}

	private doApply(): void {
		const sels: CandidateSelection[] = [];
		for (let i = 0; i < this.candidates.length; i++) {
			if (!this.selected[i]) continue;
			sels.push({ candidate: this.candidates[i], targetIndex: this.chosenTarget[i] });
		}
		this.options.onApply(sels);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
