import { App, Modal, Setting } from "obsidian";

export class TagSelectModal extends Modal {
	private selectedTags: Set<string>;
	private onConfirm: (tags: string[]) => void;
	private allTags: string[];

	constructor(app: App, currentTags: string[], onConfirm: (tags: string[]) => void) {
		super(app);
		this.selectedTags = new Set(currentTags.map((t) => t.toLowerCase()));
		this.onConfirm = onConfirm;

		const tags = (app.metadataCache as { getTags?: () => Record<string, number> }).getTags?.() ?? {};
		this.allTags = Object.keys(tags)
			.map((t) => t.replace(/^#/, ""))
			.filter((t) => t.length > 0)
			.sort((a, b) => (tags[`#${b}`] ?? 0) - (tags[`#${a}`] ?? 0));
	}

	onOpen(): void {
		this.titleEl.setText("选择要排除的标签");
		this.modalEl.addClass("smart-linker-modal");

		const { contentEl } = this;
		contentEl.empty();

		const searchInput = contentEl.createEl("input", {
			type: "text",
			placeholder: "搜索标签…",
		});
		searchInput.style.width = "100%";
		searchInput.style.marginBottom = "8px";
		searchInput.style.padding = "6px 10px";
		searchInput.style.boxSizing = "border-box";

		const listEl = contentEl.createEl("div", { cls: "smart-linker-list" });

		const render = (filter: string): void => {
			listEl.empty();
			const q = filter.toLowerCase();
			const filtered = q
				? this.allTags.filter((t) => t.toLowerCase().includes(q))
				: this.allTags;

			if (filtered.length === 0) {
				listEl.createSpan({ text: "无匹配标签", cls: "smart-linker-subtitle" });
				return;
			}

			for (const tag of filtered) {
				const row = listEl.createDiv({ cls: "smart-linker-row" });
				const cb = row.createEl("input", { type: "checkbox" });
				cb.checked = this.selectedTags.has(tag.toLowerCase());
				cb.addEventListener("change", () => {
					const key = tag.toLowerCase();
					if (cb.checked) this.selectedTags.add(key);
					else this.selectedTags.delete(key);
				});

				const main = row.createDiv({ cls: "smart-linker-main" });
				main.createSpan({ cls: "smart-linker-term", text: `#${tag}` });
			}
		};

		searchInput.addEventListener("input", () => render(searchInput.value));

		const footer = contentEl.createDiv({ cls: "smart-linker-footer" });
		footer.createEl("button", { text: "全选" }).addEventListener("click", () => {
			for (const tag of this.allTags) this.selectedTags.add(tag.toLowerCase());
			render(searchInput.value);
		});
		footer.createEl("button", { text: "清空" }).addEventListener("click", () => {
			this.selectedTags.clear();
			render(searchInput.value);
		});
		footer.createDiv({ cls: "smart-linker-spacer" });
		footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
		const confirmBtn = footer.createEl("button", { text: "确认", cls: "mod-cta" });
		confirmBtn.addEventListener("click", () => {
			this.onConfirm(Array.from(this.selectedTags));
			this.close();
		});

		render("");
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
