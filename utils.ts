/** 半开区间 [start, end)。 */
export type Range = [number, number];

/** 转义正则元字符。 */
export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
			const close = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
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
 */
export function computeProtectedRanges(text: string): Range[] {
	const ranges: Range[] = [];
	const fm = getFrontmatterRange(text);
	if (fm) ranges.push(fm);
	ranges.push(...getFencedCodeRanges(text));

	// 行内代码
	let m: RegExpExecArray | null;
	const codeRe = /`[^`\n]+`/g;
	while ((m = codeRe.exec(text)) !== null) {
		ranges.push([m.index, m.index + m[0].length]);
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
	const wikiRe = /!?\[\[[^\]\n]*\]\]/g;
	while ((m = wikiRe.exec(text)) !== null) {
		ranges.push([m.index, m.index + m[0].length]);
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
