import { ItemView, type App } from "obsidian";
import type { CandidateSelection, MatchCandidate, Replacement, SmartLinkerSettings } from "./types";
import { applyToString, buildIndex, buildReplacements, scanText } from "./linker";

/** Excalidraw 元素（仅用到必要字段）。 */
export interface ExcalidrawElement {
	id: string;
	type: string;
	text?: string;
	rawText?: string;
	link?: string;
	[key: string]: unknown;
}

/** Excalidraw 文本元素的来源上下文（挂在 candidate.source 上）。 */
export interface ExcalidrawSource {
	element: ExcalidrawElement;
	/** 原始文本快照（用于按偏移生成替换）。 */
	text: string;
}

export interface ExcalidrawScanResult {
	ea: unknown;
	candidates: MatchCandidate[];
}

type ExcalidrawAPI = {
	getViewElements: () => ExcalidrawElement[];
	setViewElements?: (elements: ExcalidrawElement[]) => void;
	save?: () => void;
};

/** 获取当前激活的 Excalidraw 视图（若无返回 null）。 */
export function getActiveExcalidrawView(app: App): ItemView | null {
	const view = app.workspace.getActiveViewOfType(ItemView as unknown as new () => ItemView);
	if (view && typeof view.getViewType === "function" && view.getViewType() === "excalidraw") return view;
	return null;
}

/** 扫描当前 Excalidraw 画板的所有文本元素，返回可链接候选。 */
export function scanExcalidraw(app: App, settings: SmartLinkerSettings): ExcalidrawScanResult | null {
	const view = getActiveExcalidrawView(app);
	if (!view) return null;
	const ea = (view as unknown as { excalidrawAPI?: ExcalidrawAPI }).excalidrawAPI;
	if (!ea || typeof ea.getViewElements !== "function") return null;

	const file = (view as unknown as { file?: { path: string } | null }).file ?? null;
	const fakeFile = file ? ({ path: file.path } as never) : null;
	const index = buildIndex(app, settings, fakeFile);

	let elements: ExcalidrawElement[] = [];
	try {
		elements = ea.getViewElements() || [];
	} catch {
		return null;
	}

	const candidates: MatchCandidate[] = [];
	for (const el of elements) {
		if (!el || el.type !== "text") continue;
		const text = el.text ?? el.rawText;
		if (typeof text !== "string" || text.length === 0) continue;
		const found = scanText(text, index, settings, {
			protect: settings.protectSpecialRanges,
			source: { element: el, text } satisfies ExcalidrawSource,
		});
		for (const c of found) candidates.push(c);
	}
	return { ea, candidates };
}

/** 把选中的候选写回 Excalidraw 文本元素（替换为 [[双链]]），并刷新画板。返回受影响元素数。 */
export function applyExcalidraw(ea: unknown, selections: CandidateSelection[]): number {
	const api = ea as ExcalidrawAPI;
	const byId = new Map<string, { element: ExcalidrawElement; text: string; reps: Replacement[] }>();
	for (const { candidate, targetIndex } of selections) {
		const src = candidate.source as ExcalidrawSource | undefined;
		const el = src?.element;
		if (!el || !el.id) continue;
		let entry = byId.get(el.id);
		if (!entry) {
			entry = { element: el, text: src.text, reps: [] };
			byId.set(el.id, entry);
		}
		entry.reps.push(...buildReplacements(src.text, candidate, targetIndex));
	}
	if (byId.size === 0) return 0;

	const newTextById = new Map<string, string>();
	for (const [id, entry] of byId) {
		newTextById.set(id, applyToString(entry.text, entry.reps));
	}

	let all: ExcalidrawElement[] = [];
	try {
		all = api.getViewElements() || [];
	} catch {
		/* ignore */
	}
	if (Array.isArray(all) && typeof api.setViewElements === "function") {
		const newAll = all.map((el) =>
			newTextById.has(el.id) ? ({ ...el, text: newTextById.get(el.id) }) : el,
		);
		api.setViewElements(newAll);
	} else {
		// 退路：直接改原对象
		for (const [id, entry] of byId) {
			(entry.element as ExcalidrawElement).text = newTextById.get(id);
		}
	}
	try {
		if (typeof api.save === "function") api.save();
	} catch {
		/* ignore */
	}
	return byId.size;
}
