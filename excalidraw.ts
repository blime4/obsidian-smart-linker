import { ItemView, type App, type TFile } from "obsidian";
import type { CandidateSelection, MatchCandidate, Replacement, SmartLinkerSettings } from "./types";
import { applyToString, buildIndex, buildReplacements, scanText } from "./linker";

/** Excalidraw 元素（仅用到必要字段）。 */
export interface ExcalidrawElement {
	id: string;
	type: string;
	/** 画布上实际渲染的文本（链接已被替换为显示文字）。 */
	text?: string;
	/** 用户键入的原始文本（含 [[链接]]），Excalidraw 插件以此为解析源。 */
	rawText?: string;
	/** 与 rawText 同义的历史字段，插件会读它。 */
	originalText?: string;
	/** 绑定到容器（矩形/椭圆/箭头标签）时指向容器 id。 */
	containerId?: string | null;
	link?: string | null;
	isDeleted?: boolean;
	[key: string]: unknown;
}

/** Excalidraw 文本元素的来源上下文（挂在 candidate.source 上）。 */
export interface ExcalidrawSource {
	element: ExcalidrawElement;
	/** 参与匹配的原文快照（rawText 优先）。 */
	text: string;
}

/**
 * ExcalidrawAutomate 中本插件用到的子集。
 * 注意：这些方法在 ExcalidrawAutomate（ea）上，**不在** view.excalidrawAPI 上
 *（后者只有 getSceneElements / updateScene / getAppState / selectElements 等）。
 */
export interface ExcalidrawApi {
	targetView?: ItemView;
	getViewElements(): ExcalidrawElement[];
	getViewSelectedElements(includeFrameChildren?: boolean): ExcalidrawElement[];
	getElement(id: string): ExcalidrawElement | undefined;
	copyViewElementsToEAforEditing(elements: ExcalidrawElement[], copyImages?: boolean): void;
	refreshTextElementSize(id: string): void;
	addElementsToView(
		repositionToCursor?: boolean,
		save?: boolean,
		newElementsOnTop?: boolean,
		shouldRestoreElements?: boolean,
		captureUpdate?: "IMMEDIATELY" | "NEVER" | "EVENTUALLY",
	): Promise<boolean>;
	destroy?(): void;
	reset?(): void;
	setView?(view: ItemView): void;
}

export interface ExcalidrawScanResult {
	ea: ExcalidrawApi;
	candidates: MatchCandidate[];
	/** 本次参与扫描的文本元素数量。 */
	elementCount: number;
	/** 是否只扫描了选中元素。 */
	selectedOnly: boolean;
}

const EXCALIDRAW_VIEW_TYPES = ["excalidraw", "excalidraw-sidepanel"];

/** 判断是否 Excalidraw 视图（主画板或侧边栏画板）。 */
export function isExcalidrawView(view: unknown): view is ItemView {
	const t = (view as ItemView | null)?.getViewType?.();
	return typeof t === "string" && EXCALIDRAW_VIEW_TYPES.includes(t);
}

/** 取当前激活的 Excalidraw 视图：优先活动叶子，其次按当前文件匹配，最后取唯一画板。 */
export function getActiveExcalidrawView(app: App): ItemView | null {
	const active = app.workspace.activeLeaf?.view ?? null;
	if (isExcalidrawView(active)) return active;

	const leaves = app.workspace.getLeavesOfType("excalidraw");
	if (leaves.length === 0) return null;
	const file = app.workspace.getActiveFile();
	if (file) {
		for (const l of leaves) {
			const v = l.view as ItemView & { file?: { path: string } | null };
			if (v?.file?.path === file.path) return v;
		}
	}
	return leaves.length === 1 ? (leaves[0].view as ItemView) : null;
}

/** 拿到绑定在该视图上的 ExcalidrawAutomate。官方入口是 window.ExcalidrawAutomate.getAPI(view)。 */
export function getExcalidrawAutomate(app: App, view: ItemView): ExcalidrawApi | null {
	const g = (window as unknown as { ExcalidrawAutomate?: { getAPI?: (v: ItemView) => ExcalidrawApi } })
		.ExcalidrawAutomate;
	if (g && typeof g.getAPI === "function") {
		try {
			const ea = g.getAPI(view);
			if (ea && typeof ea.getViewElements === "function") return ea;
		} catch {
			/* 落到退路 */
		}
	}
	// 退路：直接取 Excalidraw 插件实例上的 ea 单例，并把它指向当前视图
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { ea?: ExcalidrawApi }> } }).plugins
		?.plugins;
	if (plugins) {
		for (const [id, p] of Object.entries(plugins)) {
			if (!id.startsWith("obsidian-excalidraw-plugin") || !p?.ea) continue;
			try {
				p.ea.reset?.();
				p.ea.setView?.(view);
				return p.ea;
			} catch {
				/* 继续找下一个 */
			}
		}
	}
	return null;
}

/** 元素参与匹配的原文：rawText 优先（与 Excalidraw 插件自身一致），退化到 text。 */
export function elementRawText(el: ExcalidrawElement): string {
	const raw = el.rawText;
	return typeof raw === "string" && raw !== "" ? raw : el.text ?? "";
}

/**
 * 剪贴板里是否带图片/文件。
 *
 * 这类粘贴必须交回给 Excalidraw 自己处理：本插件的写回走
 * `copyViewElementsToEAforEditing` + `addElementsToView`，而后者会用
 * 「调用开始时抓取的整份场景快照 + 新元素」整体 `updateScene` 覆盖写回；
 * 若此刻 Excalidraw 正在把图片元素放进场景，就会被这份旧快照冲掉
 * （表现为「图片插入失败 / 图片一闪就没了」）。因此带图片的粘贴直接不介入。
 */
export function clipboardHasImageOrFile(data: DataTransfer | null): boolean {
	if (!data) return false;
	try {
		if (data.files && data.files.length > 0) return true;
		const items = data.items;
		if (items) {
			for (let i = 0; i < items.length; i++) {
				if (items[i]?.kind === "file") return true;
			}
		}
	} catch {
		/* 忽略：读不到剪贴板内容时按「没有图片」处理 */
	}
	return false;
}

/**
 * 场景里是否存在「尚未就绪」的图片元素（正在下载/解析，或还没有 fileId）。
 * 此时写回会把未完成的图片一起覆盖掉，应等待。
 */
export function hasPendingImages(elements: ExcalidrawElement[]): boolean {
	for (const el of elements) {
		if (!el || el.isDeleted || el.type !== "image") continue;
		const status = (el as { status?: string }).status;
		if (status === "pending" || status === "loading" || status === "error") return true;
		if (!(el as { fileId?: string }).fileId) return true;
	}
	return false;
}

/**
 * 场景指纹：参与匹配的元素 id + 版本 + 类型（含非文本元素）。
 * 用于判断「场景是否已经稳定」——只有连续两次轮询指纹一致，
 * 才认为 Excalidraw 自身的粘贴/插入已经结束，这时写回才安全。
 */
export function sceneSignature(elements: ExcalidrawElement[]): string {
	const parts: string[] = [];
	for (const el of elements) {
		if (!el || el.isDeleted) continue;
		parts.push(`${el.id}:${String((el as { version?: number }).version ?? "")}:${el.type}`);
	}
	parts.sort();
	return `${parts.length}|${parts.join(",")}`;
}

function isTextElement(el: ExcalidrawElement | null | undefined): boolean {
	return !!el && el.type === "text" && !el.isDeleted;
}

/**
 * 扫描 Excalidraw 画板文本元素。
 * 有选中元素时只扫选中的（与 Markdown 模式「选中优先」一致），否则扫整块画板。
 */
export function scanExcalidraw(
	app: App,
	settings: SmartLinkerSettings,
	opts?: { selectedOnly?: boolean },
): ExcalidrawScanResult | null {
	const view = getActiveExcalidrawView(app);
	if (!view) return null;
	const ea = getExcalidrawAutomate(app, view);
	if (!ea) return null;

	const file = (view as unknown as { file?: { path: string } | null }).file ?? null;
	const index = buildIndex(app, settings, file ? ({ path: file.path } as never) : null);

	let elements: ExcalidrawElement[] = [];
	let selectedOnly = false;
	try {
		if (opts?.selectedOnly !== false) {
			const sel = (ea.getViewSelectedElements?.() ?? []).filter(isTextElement);
			if (sel.length > 0) {
				elements = sel;
				selectedOnly = true;
			}
		}
		if (elements.length === 0) elements = (ea.getViewElements() ?? []).filter(isTextElement);
	} catch {
		return null;
	}

	const candidates: MatchCandidate[] = [];
	for (const el of elements) {
		const text = elementRawText(el);
		if (text.trim() === "") continue;
		const found = scanText(text, index, settings, {
			protect: settings.protectSpecialRanges,
			source: { element: el, text } satisfies ExcalidrawSource,
		});
		for (const c of found) candidates.push(c);
	}
	return { ea, candidates, elementCount: elements.length, selectedOnly };
}

/**
 * 把选中的候选写回 Excalidraw 文本元素并保存。
 *
 * **只写 `rawText`（外加兼容用的 `originalText`）**，不写 `text`、也不调 `refreshTextElementSize`。
 * 依据（obsidian-excalidraw-plugin 2.22.0-2 源码）：
 * ```
 * addElements({...}) →
 *   const {parseResult, link} = await excalidrawData.addTextElement(t.id, t.text, t.rawText);
 *   //                                              addTextElement(id, text, rawText) 内部只 parse(rawText)
 *   if (textMode === TextMode.parsed && !t.isDeleted) {
 *     const {text,x,y,width,height} = refreshTextDimensions(t, null, map, parseResult);
 *     t.text = text; t.originalText = parseResult; t.x=x; t.y=y; t.width=width; t.height=height;
 *   }
 * ```
 * 即：`rawText` 是唯一解析源，而 `text` / `originalText` / 位置 / 尺寸都由 Excalidraw 自己按解析结果回写。
 * 我们若也去改这些字段，等于跟它的原生逻辑打架，且可能留下与重载后不一致的中间值。
 *
 * 画布最终显示成什么样，取决于 Excalidraw 自身的两个设置（可用 frontmatter 按画板覆盖）：
 * `excalidraw-link-brackets`（是否显示 `[[]]`）与 `excalidraw-link-prefix`（链接前缀，如 📍）。
 * 两者都为「否 / 空」时，`[[笔记名|原文]]` 的展示文字恰好等于原文 → 真正的排版零变化。
 *
 * **并发安全**：`addElementsToView` 会用「调用开始时抓取的整份场景快照 + 新元素」
 * 整体覆盖写回，中间还夹着 `await`。所以本函数只应在场景稳定时被调用
 * （调用方先用 `hasPendingImages` / `sceneSignature` 判定），否则可能把
 * 并发插入的图片元素一起覆盖掉。若 Excalidraw 正在插入带图片的粘贴，
 * 调用方应直接不介入（见 `clipboardHasImageOrFile`）。
 */
export async function applyExcalidraw(
	ea: ExcalidrawApi,
	selections: CandidateSelection[],
	opts: { forceAlias?: boolean } = {},
): Promise<number> {
	const forceAlias = opts.forceAlias !== false;

	const byId = new Map<string, { element: ExcalidrawElement; src: string; reps: Replacement[] }>();
	for (const { candidate, targetIndex } of selections) {
		const src = candidate.source as ExcalidrawSource | undefined;
		const el = src?.element;
		if (!src || !el?.id) continue;
		let entry = byId.get(el.id);
		if (!entry) {
			entry = { element: el, src: src.text, reps: [] };
			byId.set(el.id, entry);
		}
		entry.reps.push(...buildReplacements(src.text, candidate, targetIndex, { forceAlias, escapeTable: false }));
	}

	const plan: Array<{ id: string; raw: string }> = [];
	for (const [id, entry] of byId) {
		if (entry.reps.length === 0) continue;
		const raw = applyToString(entry.src, entry.reps);
		if (raw === entry.src) continue;
		plan.push({ id, raw });
	}
	if (plan.length === 0) return 0;

	try {
		ea.copyViewElementsToEAforEditing(plan.map((p) => byId.get(p.id)!.element));
	} catch {
		return 0;
	}

	// 只写 ExcalidrawAutomate 里的副本，**绝不回退到 view 里的元素对象**：
	// view 的元素可能是只读/冻结的，赋值会直接抛异常；而且不在 EA 注册表里的对象
	// 改了也不会被写回。拿不到就跳过该元素（宁可不写，也不能把画板写坏）。
	let written = 0;
	for (const p of plan) {
		let el: ExcalidrawElement | undefined;
		try {
			el = ea.getElement?.(p.id);
		} catch {
			el = undefined;
		}
		if (!el) continue;
		try {
			// 只动这两个字段，其余（text / 位置 / 尺寸）交给 Excalidraw 从 rawText 派生
			el.rawText = p.raw;
			el.originalText = p.raw;
			written++;
		} catch {
			/* 单个元素写不进去，不影响其余元素 */
		}
	}

	if (written === 0) {
		try {
			ea.destroy?.();
		} catch {
			/* 忽略 */
		}
		return 0;
	}

	try {
		// save=true 落盘；captureUpdate=IMMEDIATELY 让这次改动可 Ctrl+Z 撤销
		await ea.addElementsToView(false, true, false, true, "IMMEDIATELY");
	} catch {
		return 0;
	} finally {
		try {
			ea.destroy?.();
		} catch {
			/* 忽略 */
		}
	}
	return written;
}

// ─────────────────── 链接装饰（📍 前缀 / [[ ]] 方括号）───────────────────

/** Excalidraw 的链接装饰设置在某块画板上的生效值。 */
export interface LinkDecoration {
	/** 是否在链接两侧显示 [[ ]] 方括号。 */
	brackets: boolean;
	/** 链接前缀（如「📍」），空串表示不加前缀。 */
	prefix: string;
	/** 取值来源：frontmatter 覆盖优先，其次 Excalidraw 插件全局设置。 */
	source: "frontmatter" | "plugin" | "unknown";
}

/** Excalidraw 的按画板覆盖用 frontmatter 键（见其 FRONTMATTER_KEYS）。 */
export const FM_LINK_BRACKETS = "excalidraw-link-brackets";
export const FM_LINK_PREFIX = "excalidraw-link-prefix";

/** 找到 Excalidraw 插件实例（官方版或 ymjr 分支）及其设置。 */
export function findExcalidrawPlugin(app: App): { id: string; settings: Record<string, unknown> | null } | null {
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> }> } })
		.plugins?.plugins;
	if (!plugins) return null;
	for (const [id, p] of Object.entries(plugins)) {
		if (id.startsWith("obsidian-excalidraw-plugin")) return { id, settings: p?.settings ?? null };
	}
	return null;
}

/**
 * 读取链接装饰在该画板上的生效值。
 * 与 Excalidraw 的 `setShowLinkBrackets()` / `setLinkPrefix()` 一致：frontmatter 覆盖优先于全局设置。
 */
export function getLinkDecoration(app: App, file: TFile | null): LinkDecoration {
	const fm = (file ? app.metadataCache.getFileCache(file)?.frontmatter : null) ?? null;
	const settings = findExcalidrawPlugin(app)?.settings ?? null;
	const hasFmBrackets = fm !== null && fm[FM_LINK_BRACKETS] !== undefined && fm[FM_LINK_BRACKETS] !== null;
	const hasFmPrefix = fm !== null && fm[FM_LINK_PREFIX] !== undefined && fm[FM_LINK_PREFIX] !== null;

	const brackets = hasFmBrackets
		? fm![FM_LINK_BRACKETS] !== false
		: settings?.showLinkBrackets === true;
	const rawPrefix = hasFmPrefix ? fm![FM_LINK_PREFIX] : settings?.linkPrefix;
	const prefix = typeof rawPrefix === "string" ? rawPrefix : "";

	if (!settings && !hasFmBrackets && !hasFmPrefix) {
		return { brackets: false, prefix: "", source: "unknown" };
	}
	return { brackets, prefix, source: hasFmBrackets || hasFmPrefix ? "frontmatter" : "plugin" };
}

/**
 * 为该画板写入 frontmatter，关掉 Excalidraw 的链接装饰（📍 前缀与 [[ ]] 方括号），
 * 使画布文字在「加链接前 / 加链接后」完全一致（含尺寸）——即真正的排版零变化。
 *
 * 返回是否真的改动了文件：true 表示 frontmatter 变了，需要重开该画板才会生效。
 */
export async function ensureZeroLayoutFrontmatter(app: App, file: TFile): Promise<boolean> {
	let changed = false;
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (fm[FM_LINK_BRACKETS] !== false) {
			fm[FM_LINK_BRACKETS] = false;
			changed = true;
		}
		if (fm[FM_LINK_PREFIX] !== "") {
			fm[FM_LINK_PREFIX] = "";
			changed = true;
		}
	});
	return changed;
}

/** 是否正在 Excalidraw 里编辑某个文本元素（此时应推迟写回，避免和文本编辑器打架）。 */
export function isEditingTextInView(view: ItemView): boolean {
	const el = document.activeElement as HTMLElement | null;
	if (!el || !view.containerEl.contains(el)) return false;
	return el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable;
}
