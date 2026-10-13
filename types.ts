import type { TFile } from "obsidian";

/** 插件设置项。 */
export interface SmartLinkerSettings {
	/** 参与匹配的最小词长度（短于此长度的笔记名/别名忽略）。 */
	minTermLength: number;
	/** 是否把笔记文件名作为可链接词。 */
	includeNoteNames: boolean;
	/** 是否把 frontmatter aliases 作为可链接词。 */
	includeAliases: boolean;
	/** 是否排除当前正在编辑的笔记自身。 */
	excludeCurrentNote: boolean;
	/** 匹配是否区分大小写。 */
	caseSensitive: boolean;
	/** 拉丁字母词是否要求整词匹配（cat 不匹配 category）。 */
	wholeWordLatin: boolean;
	/** 是否跳过代码块/公式/已有链接等特殊区域。 */
	protectSpecialRanges: boolean;
	/** 是否允许行内代码（一对反引号）内整段命中词转成 [[链接]]。 */
	linkInlineCode: boolean;
	/** 是否把指向不存在笔记、但命中某笔记别名的失效 [[链接]] 重写为该笔记。 */
	fixBrokenLinks: boolean;
	/** 排除的 tag（含此 tag 的笔记不作为链接目标，支持层级前缀，如 private 会排除 private/xxx）。 */
	excludedTags: string[];
	/** 粘贴后是否自动扫描并建链（无需按快捷键）。 */
	autoLinkOnPaste: boolean;
	/** 粘贴内容行数「严格大于」该值时触发自动双链（默认 5，即 6 行及以上触发）。 */
	autoLinkMinLines: number;
	/** 自动双链的处理范围：pasted=只处理本次粘贴的内容；note=整篇笔记。 */
	autoLinkScope: "pasted" | "note";
	/** 自动双链的落地方式：apply=直接写入；confirm=弹窗让用户勾选后再写入。 */
	autoLinkMode: "apply" | "confirm";
	/** 自动模式下是否跳过有多个候选目标的歧义词（留待手动处理）。 */
	autoLinkSkipAmbiguous: boolean;
	/** 自动双链后是否弹出结果提示。 */
	autoLinkShowNotice: boolean;
}

/** 默认设置。 */
export const DEFAULT_SETTINGS: SmartLinkerSettings = {
	minTermLength: 2,
	includeNoteNames: true,
	includeAliases: true,
	excludeCurrentNote: true,
	caseSensitive: false,
	wholeWordLatin: true,
	protectSpecialRanges: true,
	linkInlineCode: true,
	fixBrokenLinks: true,
	excludedTags: [],
	autoLinkOnPaste: true,
	autoLinkMinLines: 5,
	autoLinkScope: "pasted",
	autoLinkMode: "apply",
	autoLinkSkipAmbiguous: false,
	autoLinkShowNotice: true,
};

/** 索引中一个可链接目标：某个词指向某篇笔记。 */
export interface IndexEntry {
	/** 目标笔记文件。 */
	file: TFile;
	/** 笔记名（basename，无扩展名）。 */
	noteName: string;
	/** 该词的原文（可能是笔记名或别名）。 */
	term: string;
	/** 是否为别名（true=别名，false=笔记名本身）。 */
	isAlias: boolean;
}

/** 已有 wikilink 的解析信息（fixBrokenLinks 用）。 */
export interface WikilinkInfo {
	/** 是否为嵌入 ![[...]]。 */
	embed: boolean;
	/** 链接目标（不含 | 后显示文字，不含 # / ^ 后缀）。 */
	target: string;
	/** 原有显示文字（| 后部分），无则 undefined。 */
	display?: string;
	/** 标题/块引用后缀（如 #章节、^block），无则空串。 */
	suffix: string;
}

/** 文档中一处命中的位置区间 [from, to)。 */
export interface MatchOccurrence {
	from: number;
	to: number;
	/** 是否为行内代码整段命中；为 true 时 from/to 含反引号，替换时连同反引号一起覆写。 */
	inCode?: boolean;
	/** 是否来自已有 wikilink 的失效链接重写；为 true 时 from/to 为整个 [[...]]。 */
	link?: WikilinkInfo;
}

/** 扫描得到的一个候选链接（按词聚合）。 */
export interface MatchCandidate {
	/** 代表性命中文字（首次出现的原文）。 */
	text: string;
	/** 该词可指向的全部目标（>=1）。 */
	targets: IndexEntry[];
	/** 默认选中的目标下标。 */
	defaultTargetIndex: number;
	/** 该词在扫描窗口内的所有非重叠出现位置。 */
	occurrences: MatchOccurrence[];
	/** 来源上下文（Excalidraw 用：{ element, text }；Markdown 为空）。 */
	source?: unknown;
}

/** 弹窗确认后选中的条目。 */
export interface CandidateSelection {
	candidate: MatchCandidate;
	targetIndex: number;
}

/** 一条待应用的替换。 */
export interface Replacement {
	from: number;
	to: number;
	/** 将插入的双链文字，如 [[猫]] 或 [[猫|小猫]]。 */
	text: string;
}
