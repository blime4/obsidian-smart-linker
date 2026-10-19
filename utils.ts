/** 半开区间 [start, end)。 */
export type Range = [number, number];

/** 转义正则元字符。 */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 统计文本行数（按 \n 计；空串为 0 行，末行无换行也算一行）。 */
export function countLines(text: string): number {
	if (text === "") return 0;
	let n = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) n++;
	}
	return n;
}

/** 把 CRLF / CR 统一成 LF，便于与编辑器内部文本比对。 */
export function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** 取第一段非空行的前若干字符，作为「这段内容来自本次粘贴」的指纹。 */
export function firstMeaningfulLine(text: string, maxLen = 24): string {
	for (const line of normalizeNewlines(text).split("\n")) {
		const t = line.trim();
		if (t !== "") return t.slice(0, maxLen);
	}
	return "";
}

/** 文本是否包含粘贴指纹（用于识别 Excalidraw 里由本次粘贴产生的文本元素）。 */
export function snippetMatches(text: string, snippet: string): boolean {
	if (snippet === "") return false;
	return normalizeNewlines(text).includes(snippet);
}

/** 求两串的最长公共前缀长度。 */
export function commonPrefixLen(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

/** 求两串的最长公共后缀长度（不与公共前缀重叠部分计入）。 */
export function commonSuffixLen(a: string, b: string, prefixLen: number): number {
	const max = Math.min(a.length, b.length) - prefixLen;
	let i = 0;
	while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
	return i;
}

/** 返回 needle 在 hay 中所有出现位置里离 hint 最近的那个区间 [from, to)。 */
export function findNearestOccurrence(hay: string, needle: string, hint: number): Range | null {
	if (needle.length === 0) return null;
	let idx = hay.indexOf(needle);
	if (idx === -1) return null;
	let bestIdx = idx;
	let bestDist = Math.abs(idx - hint);
	let guard = 0;
	while ((idx = hay.indexOf(needle, idx + 1)) !== -1 && guard++ < 20000) {
		const d = Math.abs(idx - hint);
		if (d < bestDist) {
			bestDist = d;
			bestIdx = idx;
		}
	}
	return [bestIdx, bestIdx + needle.length];
}

/**
 * 求出「本次粘贴写入的区间」[from, to)，失败返回 null。
 * 依次尝试：
 *  ① 粘贴原文（换行归一后）出现在新文本中 → 取离光标最近的一处（同时可验证插入位置）。
 *  ② 前缀/后缀 diff：变更区间即本次写入内容，可覆盖换行归一、选中替换、列表自动缩进等差异。
 *  ③ 兜底：按「净增长长度 + 被替换长度」从光标处推算。
 * before/after 相同表示编辑器尚未写入（事件早于写入）或粘贴被取消，返回 null 交由上层重试。
 */
export function locateInsertedRange(
	before: string,
	after: string,
	selStart: number,
	selLen: number,
	raw: string,
): Range | null {
	const same = before === after;

	const needle = normalizeNewlines(raw);
	if (needle.length > 0) {
		const best = findNearestOccurrence(after, needle, selStart);
		if (best) {
			// 文本尚未变化时，命中的必须是「就在光标附近」的那一处，避免误伤旧文本
			if (!same || Math.abs(best[0] - selStart) <= needle.length + 200) return best;
		}
	}
	if (same) return null;

	const p = commonPrefixLen(before, after);
	const s = commonSuffixLen(before, after, p);
	const from = p;
	const to = after.length - s;
	if (to > from) return [from, to];

	// 兜底：选中被替换时，净增长度 + 原选中长度 ≈ 写入长度
	const inserted = after.length - before.length + selLen;
	if (inserted <= 0) return null;
	const start = Math.max(0, Math.min(selStart, after.length));
	const end = Math.min(start + inserted, after.length);
	return end > start ? [start, end] : null;
}

/** 把 frontmatter 的 aliases 值规整为字符串数组，兼容 string / array / 逗号分隔 / 数字。 */
export function normalizeAliases(raw: unknown): string[] {
	if (raw == null) return [];
	if (Array.isArray(raw)) {
		return raw.flatMap((v) => normalizeOne(v));
	}
	return normalizeOne(raw);
}

function normalizeOne(v: unknown): string[] {
	if (v == null) return [];
	const out: string[] = [];
	for (const part of String(v).split(",")) {
		const t = part.trim();
		if (t !== "") out.push(t);
	}
	return out;
}

/**
 * 整词边界判定：返回 true 表示 [from,to) 是一个完整的词，而非更长复合词的子串。
 * 词内字符包含字母、数字、下划线、连字符（如 Chunked-prefill / auto_link 视为整体）。
 * 因此 prefill 不会匹配 Chunked-prefill 中的 prefill。中文等非拉丁词天然通过（按字面匹配）。
 */
export function isWholeLatinWord(text: string, from: number, to: number): boolean {
	const isAlnum = (c: string): boolean => /[A-Za-z0-9]/.test(c);
	const isWordChar = (c: string): boolean => /[A-Za-z0-9_-]/.test(c);
	const first = text[from];
	const last = text[to - 1];
	const prev = from > 0 ? text[from - 1] : "";
	const next = to < text.length ? text[to] : "";
	// 匹配两端都不是拉丁字母数字（如纯中文词）时，不做整词约束。
	if (!isAlnum(first) && !isAlnum(last)) return true;
	// 与前后"词内字符"相连，说明是更大复合词的一部分，跳过。
	const leftExtends = isWordChar(prev) && isAlnum(first);
	const rightExtends = isWordChar(next) && isAlnum(last);
	return !(leftExtends || rightExtends);
}

/** 计算每行的起始偏移。 */
function getLineOffsets(text: string): number[] {
	const offsets = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) offsets.push(i + 1);
	}
	return offsets;
}

/** 解析 YAML frontmatter 区间，无则返回 null。 */
function getFrontmatterRange(text: string): Range | null {
	if (!text.startsWith("---")) return null;
	const nl = text.indexOf("\n");
	if (nl === -1) return null;
	const start = nl + 1;
	const rest = text.slice(start);
	const m = rest.match(/^(---|\.\.\.)[ \t]*$/m);
	if (!m || m.index === undefined) return null;
	return [0, start + m.index + m[0].length];
}

/** 解析围栏代码块（``` / ~~~）区间，基于行的状态机。 */
function getFencedCodeRanges(text: string): Range[] {
	const ranges: Range[] = [];
	const lineStarts = getLineOffsets(text);
	const n = lineStarts.length;
	let fenceStart = -1;
	let fenceChar = "";
	for (let i = 0; i < n; i++) {
		const ls = lineStarts[i];
		const le = i + 1 < n ? lineStarts[i + 1] : text.length;
		const line = text.slice(ls, le);
		if (fenceStart === -1) {
			const open = line.match(/^[ \t]*(`{3,}|~{3,})/);
			if (open) {
				fenceStart = ls;
				fenceChar = open[1][0];
			}
		} else {
			// 行切片含行尾 \r\n，而 $ 锚点只匹配串尾，须先剥掉才能识别闭合围栏
			const close = line.replace(/[\r\n]+$/, "").match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
			if (close && close[1][0] === fenceChar) {
				ranges.push([fenceStart, le]);
				fenceStart = -1;
				fenceChar = "";
			}
		}
	}
	if (fenceStart !== -1) ranges.push([fenceStart, text.length]);
	return ranges;
}

/**
 * 结构性行：水平分割线（--- / *** / ___）与表格分隔行（|---|---|）。
 * 这些行的字符（成组的 - 、| 等）不是正文，命中也不应被链接。
 */
function getStructuralRanges(text: string): Range[] {
	const ranges: Range[] = [];
	const lineStarts = getLineOffsets(text);
	const n = lineStarts.length;
	for (let i = 0; i < n; i++) {
		const ls = lineStarts[i];
		const le = i + 1 < n ? lineStarts[i + 1] : text.length;
		// 行切片含行尾 \r\n，先剥掉再匹配（同围栏闭合的教训）
		const line = text.slice(ls, le).replace(/[\r\n]+$/, "");
		// 水平分割线：≥3 个连续 - / * / _
		if (/^ *(-{3,}|\*{3,}|_{3,}) *$/.test(line)) {
			ranges.push([ls, le]);
			continue;
		}
		// 表格分隔行：整行仅由 | : - 与空白组成，且同时含 - 与 |
		if (line.includes("-") && line.includes("|") && /^ *\|?[ \t:|-]*$/.test(line)) {
			ranges.push([ls, le]);
		}
	}
	return ranges;
}

/** 合并重叠/相邻区间为不相交且按起点升序的数组。 */
function mergeRanges(ranges: Range[]): Range[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	const merged: Range[] = [[sorted[0][0], sorted[0][1]]];
	for (let i = 1; i < sorted.length; i++) {
		const last = merged[merged.length - 1];
		if (sorted[i][0] <= last[1]) {
			if (sorted[i][1] > last[1]) last[1] = sorted[i][1];
		} else {
			merged.push([sorted[i][0], sorted[i][1]]);
		}
	}
	return merged;
}

/**
 * 计算所有「受保护」区间：frontmatter、围栏代码块、行内代码、数学公式、
 * 已有 wikilink/embed、Markdown 链接、HTML 标签。落在其中的命中不会被链接。
 * opts.excludeInlineCode=true 时跳过行内代码区间；opts.excludeWikilinks=true 时跳过 wikilink 区间
 * （用于「行内代码内转链」「失效链接重写」需要单独判断的场景）。
 */
export function computeProtectedRanges(
	text: string,
	opts?: { excludeInlineCode?: boolean; excludeWikilinks?: boolean },
): Range[] {
	const ranges: Range[] = [];
	const fm = getFrontmatterRange(text);
	if (fm) ranges.push(fm);
	ranges.push(...getFencedCodeRanges(text));
	ranges.push(...getStructuralRanges(text));

	// 行内代码
	let m: RegExpExecArray | null;
	if (!opts?.excludeInlineCode) {
		const codeRe = /`[^`\n]+`/g;
		while ((m = codeRe.exec(text)) !== null) {
			ranges.push([m.index, m.index + m[0].length]);
		}
	}
	// 块级数学 $$...$$
	const blockMathRe = /\$\$[\s\S]*?\$\$/g;
	while ((m = blockMathRe.exec(text)) !== null) {
		ranges.push([m.index, m.index + m[0].length]);
	}
	// 行内数学 $...$（首尾不能是空格，避免误匹配 "$5 和 $10"）
	const inlineMathRe = /\$([^$\n]+?)\$/g;
	while ((m = inlineMathRe.exec(text)) !== null) {
		const inner = m[1];
		if (inner.length === 0 || inner[0] === " " || inner[inner.length - 1] === " ") continue;
		ranges.push([m.index, m.index + m[0].length]);
	}
	// wikilink 与 embed：[[...]] / ![[...]]
	if (!opts?.excludeWikilinks) {
		const wikiRe = /!?\[\[[^\]\n]*\]\]/g;
		while ((m = wikiRe.exec(text)) !== null) {
			ranges.push([m.index, m.index + m[0].length]);
		}
	}
	// Markdown 链接 [text](url)
	const mdLinkRe = /\[[^\]\n]*\]\([^)\n]*\)/g;
	while ((m = mdLinkRe.exec(text)) !== null) {
		ranges.push([m.index, m.index + m[0].length]);
	}
	// HTML 标签
	const htmlRe = /<\/?[a-zA-Z][^>\n]*>/g;
	while ((m = htmlRe.exec(text)) !== null) {
		ranges.push([m.index, m.index + m[0].length]);
	}

	return mergeRanges(ranges);
}

/**
 * 不可跨越的哨兵字符。嵌入 ![[...]] 之类在可见文本里没有对应文字，
 * 用它在投影里占一个位置，任何真实词条都不可能包含它，因此匹配不会跨过去。
 */
const BARRIER = "\u0000";

/** 投影里的一条 wikilink（只记录定位所需信息）。 */
export interface ProjectionLink {
	/** 链接目标（不含 # / ^ 后缀）。 */
	target: string;
	/** #标题 / ^块 后缀，无则空串。 */
	suffix: string;
	/** 可见文字（| 后别名，无别名则取目标）。 */
	display: string;
	/** 整个 [[...]] 在原文中的区间。 */
	fullFrom: number;
	fullTo: number;
}

/** 原文区间 ↔ 可见文本区间的一段映射。 */
export interface ProjectionSegment {
	/** 原文区间。 */
	dFrom: number;
	dTo: number;
	/** 可见文本区间。 */
	pFrom: number;
	pTo: number;
	/** 本段若是一条 wikilink，记录其信息。 */
	link?: ProjectionLink;
}

/** 文档投影：可见文本 + 逐段映射表。 */
export interface Projection {
	text: string;
	segments: ProjectionSegment[];
}

/**
 * 把文档投影成「渲染后可见的文字」。
 * - `[[目标]]` / `[[目标|显示]]` 在投影里只占「显示文字」的长度
 * - `![[嵌入]]` 用哨兵占位，保证匹配不跨越
 * 这样 `[[DFlash]] 2` 会变成 `DFlash 2`，能正常参与最长匹配。
 */
export function buildProjection(text: string): Projection {
	const segments: ProjectionSegment[] = [];
	let projected = "";
	let cursor = 0;

	const pushText = (from: number, to: number): void => {
		if (to <= from) return;
		const chunk = text.slice(from, to);
		segments.push({ dFrom: from, dTo: to, pFrom: projected.length, pTo: projected.length + chunk.length });
		projected += chunk;
	};

	const pushOpaque = (from: number, to: number, link?: ProjectionLink): void => {
		const p = projected.length;
		segments.push({ dFrom: from, dTo: to, pFrom: p, pTo: p + BARRIER.length, link });
		projected += BARRIER;
	};

	const wikiRe = /!?\[\[[^\]\n]*\]\]/g;
	let m: RegExpExecArray | null;
	while ((m = wikiRe.exec(text)) !== null) {
		const full = m[0];
		const dFrom = m.index;
		const dTo = dFrom + full.length;
		pushText(cursor, dFrom);
		cursor = dTo;

		const embed = full[0] === "!";
		if (embed) {
			pushOpaque(dFrom, dTo);
			continue;
		}
		const inner = full.slice(2, -2);
		let pipeIdx = -1;
		for (let i = 0; i < inner.length; i++) {
			if (inner[i] === "|" && (i === 0 || inner[i - 1] !== "\\")) {
				pipeIdx = i;
				break;
			}
		}
		const targetPart = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
		const aliasPart = pipeIdx === -1 ? undefined : inner.slice(pipeIdx + 1);
		const hash = targetPart.search(/[#^]/);
		const target = hash === -1 ? targetPart : targetPart.slice(0, hash);
		const suffix = hash === -1 ? "" : targetPart.slice(hash);
		const display = aliasPart !== undefined ? aliasPart : target;
		if (target === "" || display === "" || display.includes("|")) {
			// 目标为空、显示为空、或显示文字里还有未转义管道：不参与补全，整段当哨兵
			pushOpaque(dFrom, dTo);
			continue;
		}
		segments.push({ dFrom, dTo, pFrom: projected.length, pTo: projected.length + display.length, link: { target, suffix, display, fullFrom: dFrom, fullTo: dTo } });
		projected += display;
	}
	pushText(cursor, text.length);
	return { text: projected, segments };
}

/** 在投影里定位同时包含 p 的一段（isEnd=true 时按右边界语义）。 */
function locateSegment(segments: ProjectionSegment[], p: number, isEnd: boolean): ProjectionSegment | null {
	for (let i = segments.length - 1; i >= 0; i--) {
		const s = segments[i];
		if (isEnd ? p > s.pFrom && p <= s.pTo : p >= s.pFrom && p < s.pTo) return s;
	}
	return null;
}

/** 投影区间映射回原文的结果。 */
export interface ProjectedRange {
	dFrom: number;
	dTo: number;
	/** 区间内被完整覆盖的 wikilink。 */
	links: ProjectionLink[];
}

/**
 * 把投影区间 [pFrom,pTo) 映射回原文区间。
 * 命中若从链接显示文字中间开始、或在其中间结束，返回 null（不允许改动半截链接）。
 */
export function mapProjectedRange(proj: Projection, pFrom: number, pTo: number): ProjectedRange | null {
	if (pTo <= pFrom) return null;
	const sSeg = locateSegment(proj.segments, pFrom, false);
	const eSeg = locateSegment(proj.segments, pTo, true);
	if (!sSeg || !eSeg) return null;

	let dFrom: number;
	if (sSeg.link) {
		if (pFrom !== sSeg.pFrom) return null;
		dFrom = sSeg.dFrom;
	} else {
		dFrom = sSeg.dFrom + (pFrom - sSeg.pFrom);
	}

	let dTo: number;
	if (eSeg.link) {
		if (pTo !== eSeg.pTo) return null;
		dTo = eSeg.dTo;
	} else {
		dTo = eSeg.dFrom + (pTo - eSeg.pFrom);
	}

	const links: ProjectionLink[] = [];
	for (const s of proj.segments) {
		if (s.link && pFrom <= s.pFrom && s.pTo <= pTo) links.push(s.link);
	}
	return { dFrom, dTo, links };
}

/** 判断 [from,to) 是否落在任意受保护区间内（ranges 须已合并、升序、不相交）。 */
export function isProtected(ranges: Range[], from: number, to: number): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const [s, e] = ranges[mid];
		if (e <= from) {
			lo = mid + 1;
		} else if (s >= to) {
			hi = mid - 1;
		} else {
			return true;
		}
	}
	return false;
}
