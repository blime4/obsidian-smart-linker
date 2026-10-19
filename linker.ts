import type { App, CachedMetadata, Editor, EditorPosition, TFile } from "obsidian";
import type { IndexEntry, MatchCandidate, MatchOccurrence, Replacement, SmartLinkerSettings, WikilinkInfo } from "./types";
import { buildProjection, computeProtectedRanges, escapeRegExp, isProtected, isWholeLatinWord, mapProjectedRange, normalizeAliases, type Range } from "./utils";

/** 扫描结果：候选链接列表 + 原文 + 扫描窗口。 */
export interface ScanResult {
	candidates: MatchCandidate[];
	text: string;
	window: Range;
}

/** 收集一篇笔记的全部 tag（去 #、小写）。覆盖 frontmatter 与正文内联 #tag。 */
function getFileTags(cache: CachedMetadata | null | undefined): string[] {
	const out = new Set<string>();
	if (!cache) return [];
	// frontmatter 中的 tags / tag
	const fmTags = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
	if (fmTags != null) {
		const arr = Array.isArray(fmTags) ? fmTags : String(fmTags).split(/[,;\s]+/);
		for (const t of arr) {
			const n = String(t).trim().replace(/^#/, "").toLowerCase();
			if (n) out.add(n);
		}
	}
	// CachedMetadata.tags 是 TagCache[]（含 frontmatter 与正文内联全部标签）
	const tagList = cache.tags as unknown as Array<{ tag: string }> | undefined;
	if (Array.isArray(tagList)) {
		for (const tc of tagList) {
			const n = String(tc.tag).trim().replace(/^#/, "").toLowerCase();
			if (n) out.add(n);
		}
	}
	return Array.from(out);
}

/** 判断文件 tag 是否命中排除列表（支持层级前缀：private 命中 private/xxx）。 */
function hasExcludedTag(fileTags: string[], excluded: string[]): boolean {
	if (excluded.length === 0) return false;
	const ex = excluded.map((e) => e.trim().replace(/^#/, "").toLowerCase()).filter((e) => e !== "");
	for (const t of fileTags) {
		for (const e of ex) {
			if (t === e || t.startsWith(`${e}/`)) return true;
		}
	}
	return false;
}

/**
 * 构建「词 -> 目标列表」索引。
 * 遍历 vault 所有 markdown 笔记与 excalidraw 画板，把文件名(去扩展名)与 frontmatter aliases 注册为可链接词。
 * 排除当前笔记自身，以及带排除 tag 的笔记。
 */
export function buildIndex(app: App, settings: SmartLinkerSettings, currentFile: TFile | null): Map<string, IndexEntry[]> {
	const index = new Map<string, IndexEntry[]>();

	const add = (file: TFile, term: string, isAlias: boolean): void => {
		const t = term.trim();
		if (t.length < settings.minTermLength) return;
		// 纯符号名（如 "--"）无链接价值，且会大量命中表格分隔线等结构，跳过
		if (!/[A-Za-z0-9㐀-鿿぀-ヿ가-힯]/.test(t)) return;
		const key = settings.caseSensitive ? t : t.toLowerCase();
		const entry: IndexEntry = { file, noteName: file.basename, term: t, isAlias };
		const list = index.get(key);
		if (list) list.push(entry);
		else index.set(key, [entry]);
	};

	for (const file of app.vault.getMarkdownFiles()) {
		if (settings.excludeCurrentNote && currentFile && file.path === currentFile.path) continue;

		const cache = app.metadataCache.getFileCache(file);
		if (settings.excludedTags.length > 0 && hasExcludedTag(getFileTags(cache), settings.excludedTags)) continue;

		if (settings.includeNoteNames) add(file, file.basename, false);
		if (settings.includeAliases) {
			const aliases = normalizeAliases(cache?.frontmatter?.aliases ?? cache?.frontmatter?.alias);
			for (const a of aliases) add(file, a, true);
		}
	}

	for (const file of app.vault.getFiles()) {
		if (file.extension !== "excalidraw") continue;
		if (settings.excludeCurrentNote && currentFile && file.path === currentFile.path) continue;
		if (settings.includeNoteNames) add(file, file.basename, false);
	}

	return index;
}

/** 用 term 专用正则枚举其在 text 中的所有出现位置。 */
function findOccurrences(text: string, term: string, settings: SmartLinkerSettings): MatchOccurrence[] {
	const re = new RegExp(escapeRegExp(term), settings.caseSensitive ? "g" : "gi");
	const out: MatchOccurrence[] = [];
	let m: RegExpExecArray | null;
	let guard = 0;
	while ((m = re.exec(text)) !== null && guard++ < 200000) {
		const from = m.index;
		const to = from + m[0].length;
		if (to === from) {
			re.lastIndex++;
			continue;
		}
		if (!settings.wholeWordLatin || isWholeLatinWord(text, from, to)) {
			out.push({ from, to });
		}
	}
	return out;
}

/** 按 file.path 去重目标，保留不同文件作为歧义选项（同一 key 下 term 恒定）。 */
function dedupeTargets(targets: IndexEntry[]): IndexEntry[] {
	const seen = new Set<string>();
	const out: IndexEntry[] = [];
	for (const t of targets) {
		const k = t.file.path;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(t);
	}
	return out;
}

/**
 * 「补全已有双链」专用：把候选目标限制为「原链接本来就指向的那些文件」。
 * 找不到可对应关系时返回 null（宁可不改，也不悄悄改链接去向）。
 */
function compatibleTargets(
	index: Map<string, IndexEntry[]>,
	linkTarget: string,
	targets: IndexEntry[],
	norm: (s: string) => string,
): IndexEntry[] | null {
	const base = linkTarget.split("/").pop() ?? linkTarget;
	if (base === "") return null;
	const current = index.get(norm(base)) ?? [];
	const paths = new Set(current.map((e) => e.file.path));
	const out = targets.filter((t) => paths.has(t.file.path) || t.noteName === base);
	return out.length > 0 ? out : null;
}

/**
 * 核心：在给定文本上扫描可链接候选。
 * 可选 window 限定区间；可选 protect 跳过特殊区域；可选 source 标注来源（Excalidraw 元素等）。
 */
export function scanText(
	text: string,
	index: Map<string, IndexEntry[]>,
	settings: SmartLinkerSettings,
	opts?: { window?: Range; protect?: boolean; source?: unknown },
): MatchCandidate[] {
	const window: Range = opts?.window ?? [0, text.length];
	const protect = opts?.protect ?? true;
	// 保护区间三档：整档 / 放行行内代码整段 / 放行行内代码整段 + wikilink（失效链接重写用）
	const protectedRanges = protect ? computeProtectedRanges(text) : [];
	const codeProtected =
		protect && settings.linkInlineCode ? computeProtectedRanges(text, { excludeInlineCode: true }) : [];
	const linkProtected =
		(protect && settings.fixBrokenLinks) || settings.linkExtendToLongest
			? computeProtectedRanges(text, { excludeWikilinks: true })
			: [];
	const norm = (s: string): string => (settings.caseSensitive ? s : s.toLowerCase());
	const lowerText = settings.caseSensitive ? null : text.toLowerCase();

	type RawOcc = { from: number; to: number; key: string; targets: IndexEntry[]; inCode?: boolean; link?: WikilinkInfo };
	const raw: RawOcc[] = [];
	for (const [key, targets] of index) {
		const present = lowerText !== null ? lowerText.indexOf(key) !== -1 : text.indexOf(key) !== -1;
		if (!present) continue;
		for (const o of findOccurrences(text, targets[0].term, settings)) {
			raw.push({ from: o.from, to: o.to, key, targets });
		}
	}

	// 行内代码整段命中：`EagleDraftWorker`（反引号计入范围）→ 整段替换为 [[EagleDraftWorker]]。
	// 仅当反引号内内容与某笔记名/别名完全相等才可链；普通子串命中仍被保护区间挡住。
	if (protect && settings.linkInlineCode) {
		const codeRe = /`[^`\n]+`/g;
		let m: RegExpExecArray | null;
		while ((m = codeRe.exec(text)) !== null) {
			const inner = m[0].slice(1, -1);
			const key = settings.caseSensitive ? inner : inner.toLowerCase();
			const targets = index.get(key);
			if (!targets) continue;
			raw.push({ from: m.index, to: m.index + m[0].length, key, targets, inCode: true });
		}
	}

	// 失效 wikilink 重写：[[EAGLE]] 指向已删除笔记、但其名恰好是某笔记别名 → 候选，重写为 [[EAGLE-3|EAGLE]]。
	// 目标笔记仍存在（链接有效）或目标非别名（无法解析）的情况跳过。
	if (protect && settings.fixBrokenLinks) {
		const linkRe = /!?\[\[([^\]\n]*)\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = linkRe.exec(text)) !== null) {
			const full = m[0];
			const inner = m[1];
			let pipeIdx = -1;
			for (let i = 0; i < inner.length; i++) {
				if (inner[i] === "|" && (i === 0 || inner[i - 1] !== "\\")) {
					pipeIdx = i;
					break;
				}
			}
			const targetPart = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
			const display = pipeIdx === -1 ? undefined : inner.slice(pipeIdx + 1);
			const hash = targetPart.search(/[#^]/);
			const base = hash === -1 ? targetPart : targetPart.slice(0, hash);
			const suffix = hash === -1 ? "" : targetPart.slice(hash);
			if (!base) continue;
			const targets = index.get(norm(base));
			if (!targets) continue;
			if (targets.some((t) => !t.isAlias)) continue;
			raw.push({
				from: m.index,
				to: m.index + full.length,
				key: norm(base),
				targets,
				link: { embed: full[0] === "!", target: base, display, suffix },
			});
		}
	}

	// 已有双链补全为最长匹配：`[[DFlash]] 2` → `[[DFlash|DFlash 2]]`。
	// 做法：把文档投影成「可见文字」后重新做最长匹配，再把命中区间映射回原文。
	// 这样链接不会再把词切断，链接也能参与「最长优先」的竞争。
	if (settings.linkExtendToLongest && text.includes("[[")) {
		const proj = buildProjection(text);
		const projLower = settings.caseSensitive ? null : proj.text.toLowerCase();
		for (const [key, targets] of index) {
			const present = projLower !== null ? projLower.indexOf(key) !== -1 : proj.text.indexOf(key) !== -1;
			if (!present) continue;
			for (const o of findOccurrences(proj.text, targets[0].term, settings)) {
				const visible = proj.text.slice(o.from, o.to);
				const mapped = mapProjectedRange(proj, o.from, o.to);
				if (!mapped) continue;
				// 必须正好覆盖一条链接：0 条＝纯文本（主扫描已处理），≥2 条＝会吞并其它链接
				if (mapped.links.length !== 1) continue;
				const link = mapped.links[0];
				if (link.suffix !== "") continue; // 带 #标题 / ^块 的不动
				if (visible === link.display) continue; // 没有变长，无需改写
				// 只改「目标不变」的链接；指向别的笔记时宁可不动
				const compatible = compatibleTargets(index, link.target, targets, norm);
				if (!compatible) continue;
				raw.push({
					from: mapped.dFrom,
					to: mapped.dTo,
					key,
					targets: compatible,
					link: { embed: false, target: link.target, display: visible, suffix: "", extended: true },
				});
			}
		}
	}

	const valid = raw.filter((o) => {
		if (o.from < window[0] || o.to > window[1]) return false;
		// 失效链接重写 / 补全已有链接 / 行内代码整段命中要放行「自身所在区间」，但仍受其它区域保护
		const ranges = o.link ? linkProtected : o.inCode ? codeProtected : protectedRanges;
		return !(ranges.length > 0 && isProtected(ranges, o.from, o.to));
	});

	valid.sort((a, b) => b.to - b.from - (a.to - a.from) || a.from - b.from);
	const kept: RawOcc[] = [];
	for (const o of valid) {
		let overlap = false;
		for (const k of kept) {
			if (o.from < k.to && k.from < o.to) {
				overlap = true;
				break;
			}
		}
		if (!overlap) kept.push(o);
	}

	const byKey = new Map<string, MatchCandidate>();
	for (const o of kept) {
		// 补全项单独成组：它的目标被限定为「原链接指向的文件」，不能与同名的普通候选混在一起
		const groupKey = o.link?.extended ? `${o.key}\u0000extend` : o.key;
		let c = byKey.get(groupKey);
		if (!c) {
			c = { text: "", targets: dedupeTargets(o.targets), defaultTargetIndex: 0, occurrences: [], source: opts?.source };
			byKey.set(groupKey, c);
		}
		c.occurrences.push({ from: o.from, to: o.to, inCode: o.inCode, link: o.link });
	}

	for (const c of byKey.values()) {
		c.occurrences.sort((a, b) => a.from - b.from);
		const first = c.occurrences[0];
		// 代表性文字：补全项取命中的完整可见文字；行内代码去掉反引号；其余取原文片段
		c.text = first.link?.extended
			? (first.link.display ?? first.link.target)
			: first.inCode
				? text.substring(first.from + 1, first.to - 1)
				: text.substring(first.from, first.to);
		const nameIdx = c.targets.findIndex((t) => !t.isAlias);
		c.defaultTargetIndex = nameIdx >= 0 ? nameIdx : 0;
	}

	return Array.from(byKey.values()).sort((a, b) => a.occurrences[0].from - b.occurrences[0].from);
}

/**
 * 扫描当前 Markdown 编辑器文本（智能范围：有选中只扫选中，否则整篇）。
 */
export function scan(app: App, editor: Editor, file: TFile | null, settings: SmartLinkerSettings): ScanResult {
	const text = editor.getValue();
	let window: Range;
	if (editor.somethingSelected()) {
		const sel = editor.listSelections()[0];
		window = [editor.posToOffset(sel.anchor), editor.posToOffset(sel.head)];
		if (window[0] > window[1]) {
			const tmp = window[0];
			window[0] = window[1];
			window[1] = tmp;
		}
	} else {
		window = [0, text.length];
	}
	window[0] = Math.max(0, Math.min(window[0], text.length));
	window[1] = Math.max(window[0], Math.min(window[1], text.length));

	const index = buildIndex(app, settings, file);
	const candidates = scanText(text, index, settings, { window, protect: settings.protectSpecialRanges });
	return { candidates, text, window };
}

/** 判断 [from,to) 所在行是否表格行（支持被 Markdown 引用包裹的 > | a |）。 */
function isTableCellLine(text: string, from: number, to: number): boolean {
	const lineStart = text.lastIndexOf("\n", from) + 1;
	let lineEnd = text.indexOf("\n", to);
	if (lineEnd === -1) lineEnd = text.length;
	return /^\s*(?:>\s*)*\|/.test(text.slice(lineStart, lineEnd));
}

/**
 * 为某个候选 + 选定目标生成全部替换。
 * opts.forceAlias=true 时总是写成 `[[笔记名|原文]]`（Excalidraw 用：展示文本与原文一致，排版零变化）。
 * opts.escapeTable=false 时不做表格管道转义（Excalidraw 画板里没有 Markdown 表格）。
 */
export function buildReplacements(
	text: string,
	candidate: MatchCandidate,
	targetIndex: number,
	opts: { forceAlias?: boolean; escapeTable?: boolean } = {},
): Replacement[] {
	const target = candidate.targets[targetIndex] ?? candidate.targets[0];
	const out: Replacement[] = [];
	for (const occ of candidate.occurrences) {
		const inTable = opts.escapeTable !== false && isTableCellLine(text, occ.from, occ.to);
		const sep = inTable ? "\\|" : "|";
		// 已有 wikilink 的失效链接重写 / 补全：整段替换为 [[新笔记名(后缀)|显示文字]]
		if (occ.link) {
			const display = occ.link.display ?? occ.link.target;
			const bang = occ.link.embed ? "!" : "";
			const dest = `${target.noteName}${occ.link.suffix}`;
			out.push({
				from: occ.from,
				to: occ.to,
				// 显示文字与目标同名时不必写别名（Excalidraw 要求保留原文时除外）
				text: display === dest && !opts.forceAlias ? `${bang}[[${dest}]]` : `${bang}[[${dest}${sep}${display}]]`,
			});
			continue;
		}
		// 行内代码整段命中的原文含反引号，比对与别名展示都按去掉反引号后的内容算
		let matched = text.substring(occ.from, occ.to);
		if (occ.inCode) matched = matched.slice(1, -1);
		if (matched === target.noteName && !opts.forceAlias) {
			out.push({ from: occ.from, to: occ.to, text: `[[${target.noteName}]]` });
			continue;
		}
		// 别名形式的 | 在表格行内必须转义为 \| ，否则单元格被管道切断
		out.push({ from: occ.from, to: occ.to, text: `[[${target.noteName}${sep}${matched}]]` });
	}
	return out;
}

/** 取双链的「显示文字」：`[[目标|显示]]` → 显示，`[[目标]]` → 目标；非双链原样返回。 */
export function linkDisplayText(link: string): string {
	const m = /^!?\[\[([^\]\n]*)\]\]$/.exec(link);
	if (!m) return link;
	const inner = m[1];
	const pipe = inner.indexOf("|");
	return pipe === -1 ? inner : inner.slice(pipe + 1);
}

/** 把替换应用到纯文本字符串（倒序拼接），返回新字符串。用于 Excalidraw 文本元素。 */
export function applyToString(text: string, reps: Replacement[]): string {
	const sorted = [...reps].sort((a, b) => b.from - a.from);
	let out = text;
	for (const r of sorted) {
		out = out.slice(0, r.from) + r.text + out.slice(r.to);
	}
	return out;
}

/** 应用替换到编辑器：优先单步 transaction，否则倒序 replaceRange。 */
export function applyReplacements(editor: Editor, reps: Replacement[]): void {
	if (reps.length === 0) return;
	const sorted = [...reps].sort((a, b) => b.from - a.from);
	const changes: Array<{ from: EditorPosition; to: EditorPosition; text: string }> = sorted.map((r) => ({
		from: editor.offsetToPos(r.from),
		to: editor.offsetToPos(r.to),
		text: r.text,
	}));
	const withTx = editor as Editor & {
		transaction?: (spec: { changes: Array<{ from: EditorPosition; to: EditorPosition; text: string }> }) => void;
	};
	if (typeof withTx.transaction === "function") {
		withTx.transaction({ changes });
		return;
	}
	for (const r of sorted) {
		editor.replaceRange(r.text, editor.offsetToPos(r.from), editor.offsetToPos(r.to));
	}
}
