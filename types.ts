import type { TFile } from "obsidian";

/** 插件设置项。 */
export interface SmartLinkerSettings {
	/** 参与匹配的最小���长度（短于此长度的笔记名/别名忽略）。 */
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
	/** 排除的 tag（含此 tag 的笔记不作为链接目标，支持层级前缀，如 private 会排除 private/xxx）。 */
	excludedTags: string[];
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
	excludedTags: [],
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

/** 文档中一处命中的位置区间 [from, to)。 */
export interface MatchOccurrence {
	from: number;
	to: number;
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
