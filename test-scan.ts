import type { App, TFile } from "obsidian";
import { buildIndex, buildReplacements, scanText } from "./linker";
import { DEFAULT_SETTINGS, type SmartLinkerSettings } from "./types";

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

// ── 构造一个最小 vault ──────────────────────────────────────────────
type MockFile = { path: string; basename: string; extension: string; aliases?: string[] };
const files: MockFile[] = [
	{ path: "EAGLE-3.md", basename: "EAGLE-3", extension: "md", aliases: ["EAGLE", "EAGLE3"] },
	{ path: "Chunked-prefill.md", basename: "Chunked-prefill", extension: "md" },
	{ path: "猫.md", basename: "猫", extension: "md", aliases: ["小猫"] },
	{ path: "绘图.excalidraw", basename: "绘图", extension: "excalidraw" },
];
const caches: Record<string, unknown> = {
	"EAGLE-3.md": { frontmatter: { aliases: ["EAGLE", "EAGLE3"] } },
	"Chunked-prefill.md": { frontmatter: {} },
	"猫.md": { frontmatter: { aliases: ["小猫"] } },
};
const app = {
	vault: {
		getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
		getFiles: () => files,
	},
	metadataCache: { getFileCache: (f: MockFile) => caches[f.path] ?? null },
} as unknown as App;

const S: SmartLinkerSettings = { ...DEFAULT_SETTINGS, excludedTags: [] };
const index = buildIndex(app, S, null);

console.log("索引：");
eq("别名 EAGLE 指向 EAGLE-3", index.get("eagle")?.[0]?.noteName, "EAGLE-3");
eq("笔记名 Chunked-prefill", index.get("chunked-prefill")?.[0]?.noteName, "Chunked-prefill");
eq("中文别名 小猫", index.get("小猫")?.[0]?.noteName, "猫");
eq("Excalidraw 画板名入索引", index.get("绘图")?.[0]?.noteName, "绘图");

// ── 窗口内扫描 ─────────────────────────────────────────────────────
const doc = [
	"---", // 0
	"aliases: [占位]", // 1
	"---", // 2
	"", // 3
	"旧内容里有 EAGLE 这个词", // 4  ← 窗口外，不应被链
	"", // 5
	"```text", // 6
	"EAGLE 在代码块里不算", // 7
	"```", // 8
	"", // 9
	"新粘贴段：EAGLE 与 Chunked-prefill 联动", // 10 ← 窗口内
	"还有小猫在跑。", // 11 ← 窗口内
	"",
].join("\n");

const lines = doc.split("\n");
// 用行偏移求出「粘贴区间」= 第 10~11 行
function lineOffset(n: number): number {
	let off = 0;
	for (let i = 0; i < n; i++) off += lines[i].length + 1;
	return off;
}
const win: [number, number] = [lineOffset(10), lineOffset(12) - 1];

console.log("\n窗口内扫描：");
const cands = scanText(doc, index, S, { window: win, protect: S.protectSpecialRanges });
eq("候选词按出现位置排序", cands.map((c) => c.text), ["EAGLE", "Chunked-prefill", "小猫"]);
eq("EAGLE 出现 1 次（窗口外与代码块内都不算）", cands.find((c) => c.text === "EAGLE")?.occurrences.length, 1);
eq("EAGLE 默认目标为笔记名 EAGLE-3", cands.find((c) => c.text === "EAGLE")?.targets[0].noteName, "EAGLE-3");

console.log("\n生成的替换：");
const reps = cands.flatMap((c) => buildReplacements(doc, c, c.defaultTargetIndex));
eq("替换条数", reps.length, 3);
eq("别名写成 [[EAGLE-3|EAGLE]]", reps.some((r) => r.text === "[[EAGLE-3|EAGLE]]"), true);
eq("中文别名写成 [[猫|小猫]]", reps.some((r) => r.text === "[[猫|小猫]]"), true);
eq("同名写成 [[Chunked-prefill]]", reps.some((r) => r.text === "[[Chunked-prefill]]"), true);

// 倒序应用，验证结果文本
const applied = [...reps].sort((a, b) => b.from - a.from).reduce((acc, r) => acc.slice(0, r.from) + r.text + acc.slice(r.to), doc);
console.log("\n应用后相关行：");
console.log(applied.split("\n").slice(4, 12).map((l, i) => `   ${i + 4}: ${l}`).join("\n"));
eq("窗口外旧内容未被动", applied.includes("旧内容里有 EAGLE 这个词"), true);
eq("代码块内未被动", applied.includes("EAGLE 在代码块里不算"), true);
eq("窗口内已建链", applied.includes("[[EAGLE-3|EAGLE]] 与 [[Chunked-prefill]] 联动"), true);

// ── 表格行内的别名要转义 | ──────────────────────────────────────────
console.log("\n表格行转义：");
const tableDoc = "| 名称 | 说明 |\n|---|---|\n| 小猫 | 宠物 |";
const tableCands = scanText(tableDoc, index, S, { window: [0, tableDoc.length], protect: true });
const tableRep = buildReplacements(tableDoc, tableCands[0], 0);
eq("表格内别名管道转义", tableRep[0].text, "[[猫\\|小猫]]");

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
