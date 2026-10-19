import type { App } from "obsidian";
import { applyToString, buildIndex, buildReplacements, scanText } from "./linker";
import { DEFAULT_SETTINGS, type SmartLinkerSettings } from "./types";
import { buildProjection, mapProjectedRange } from "./utils";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got);
	const w = JSON.stringify(want);
	if (g === w) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}\n       got=${g}\n      want=${w}`);
	}
}

// ── 最小 vault ─────────────────────────────────────────────────────
type MockFile = { path: string; basename: string; extension: string };
const mk = (basename: string): MockFile => ({ path: `${basename}.md`, basename, extension: "md" });

const files: MockFile[] = [
	mk("DFlash"),
	mk("EAGLE-3"),
	mk("猫"),
	mk("Cat"),
	mk("Cat 2"),
	mk("A"),
	mk("B"),
	mk("AB"),
];
const caches: Record<string, unknown> = {
	"DFlash.md": { frontmatter: { aliases: ["DFlash2", "DFlash 2"] } },
	"EAGLE-3.md": { frontmatter: { aliases: ["EAGLE", "EAGLE3"] } },
	"猫.md": { frontmatter: { aliases: ["小猫", "猫咪"] } },
	"AB.md": { frontmatter: { aliases: ["A B"] } },
};
const app = {
	vault: {
		getMarkdownFiles: () => files,
		getFiles: () => files,
	},
	metadataCache: { getFileCache: (f: MockFile) => caches[f.path] ?? null },
} as unknown as App;

const S: SmartLinkerSettings = { ...DEFAULT_SETTINGS, excludedTags: [] };
const index = buildIndex(app, S, null);

/** 扫全文并落成替换后的文本。 */
function run(text: string, settings: SmartLinkerSettings = S): { cands: ReturnType<typeof scanText>; out: string } {
	const cands = scanText(text, index, settings, { window: [0, text.length], protect: true });
	const reps = cands.flatMap((c) => buildReplacements(text, c, c.defaultTargetIndex));
	return { cands, out: applyToString(text, reps) };
}

function count(text: string, settings: SmartLinkerSettings = S): number {
	return run(text, settings).cands.length;
}

console.log("投影基础：");
{
	const p1 = buildProjection("[[DFlash]] 2");
	eq("链接换成显示文字", p1.text, "DFlash 2");
	const p2 = buildProjection("前置 [[目标|别名文字]] 后置");
	eq("别名取显示文字", p2.text, "前置 别名文字 后置");
	const p3 = buildProjection("![[]]");
	eq("空链接当哨兵", p3.text.length, 1);
	const p4 = buildProjection("a ![[img.png]] b");
	eq("嵌入占一个哨兵位", p4.text, "a \u0000 b");
	const m = mapProjectedRange(p1, 0, 8);
	eq("区间映射回原文", m && [m.dFrom, m.dTo, m.links.length], [0, 12, 1]);
	const mid = mapProjectedRange(buildProjection("[[X|abcdef]]"), 2, 5);
	eq("从链接中间开始 → 不映射", mid, null);
}

console.log("\n补全已有双链：");
eq("[[DFlash]] 2", run("[[DFlash]] 2").out, "[[DFlash|DFlash 2]]");
eq("[[DFlash]]2（无空格）", run("[[DFlash]]2").out, "[[DFlash|DFlash2]]");
eq("[[DFlash|DFlash]] 2（显式别名）", run("[[DFlash|DFlash]] 2").out, "[[DFlash|DFlash 2]]");
eq("候选文字取完整词", run("[[DFlash]] 2").cands[0]?.text, "DFlash 2");
eq("只产生 1 个候选", count("[[DFlash]] 2"), 1);
eq("句末标点不阻挡", run("用 [[DFlash]] 2。").out, "用 [[DFlash|DFlash 2]]。");
eq("中文紧邻", run("[[猫]]咪").out, "[[猫|猫咪]]");
eq("两处同词聚合为一个候选", run("[[DFlash]] 2 与 [[DFlash]] 2").cands[0]?.occurrences.length, 2);
eq("两处都改写", run("[[DFlash]] 2 与 [[DFlash]] 2").out, "[[DFlash|DFlash 2]] 与 [[DFlash|DFlash 2]]");

console.log("\n幂等与不动：");
eq("已是 [[DFlash|DFlash 2]] 不再改", count("[[DFlash|DFlash 2]]"), 0);
eq("孤立 [[DFlash]] 不改（无增益）", count("[[DFlash]]"), 0);
eq("幂等：改完再扫为 0", count(run("[[DFlash]] 2").out), 0);

console.log("\n边界与安全阀：");
eq("[[DFlash]] 21 不匹配（右边界）", count("[[DFlash]] 21"), 0);
eq("[[DFlash]] 2x 不匹配（右边界）", count("[[DFlash]] 2x"), 0);
eq("不跨行", count("[[DFlash]]\n2"), 0);
eq("嵌入 ![[DFlash]] 2 不动", count("![[DFlash]] 2"), 0);
eq("带 #标题 后缀不动", count("[[DFlash#0x04]] 2"), 0);
eq("目标不同则跳过（Cat → Cat 2）", count("[[Cat]] 2"), 0);
eq("两个链接不被合并", count("[[A]] [[B]]"), 0);
eq("代码块内不动", count("```\n[[DFlash]] 2\n```"), 0);
eq("行内代码内不动", count("`[[DFlash]] 2`"), 0);

console.log("\n表格转义：");
{
	const r = run("| a | b |\n|---|---|\n| [[DFlash]] 2 | x |");
	eq("表格内管道转义", r.out.includes("| [[DFlash\\|DFlash 2]] | x |"), true);
}

console.log("\n开关：");
{
	const off: SmartLinkerSettings = { ...S, linkExtendToLongest: false };
	eq("关闭后不再补全", count("[[DFlash]] 2", off), 0);
}

console.log("\n与失效链接重写共存：");
{
	// [[EAGLE]] 指向不存在的笔记，但 EAGLE 是 EAGLE-3 的别名 → 原有能力仍然工作
	eq("失效链接仍被重写", run("[[EAGLE]] 用法").out, "[[EAGLE-3|EAGLE]] 用法");
	// 同一段里既有失效链接又有补全，两者互不干扰
	const both = run("[[EAGLE]] 和 [[DFlash]] 2");
	eq("并存时两处都改", both.out, "[[EAGLE-3|EAGLE]] 和 [[DFlash|DFlash 2]]");
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
