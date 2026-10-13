import { countLines, locateInsertedRange, normalizeNewlines, type Range } from "./utils";

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
function region(name: string, before: string, after: string, selStart: number, selLen: number, raw: string, want: Range | null): void {
	const r = locateInsertedRange(before, after, selStart, selLen, raw);
	eq(name, r, want);
	const slice = r ? after.slice(r[0], r[1]) : null;
	console.log(`       slice=${JSON.stringify(slice)}`);
}

console.log("countLines:");
eq("空串=0", countLines(""), 0);
eq("单行=1", countLines("abc"), 1);
eq("6 行", countLines("1\n2\n3\n4\n5\n6"), 6);
eq("末尾换行 6 行", countLines("1\n2\n3\n4\n5\n6\n"), 7);
eq("CRLF 6 行", countLines("1\r\n2\r\n3\r\n4\r\n5\r\n6"), 6);
eq("normalizeNewlines", normalizeNewlines("a\r\nb\rc"), "a\nb\nc");

console.log("\nlocateInsertedRange:");

// 1) 事件早于写入：文档里还没有粘贴内容
{
	const raw = "Chunked-prefill 是一种技术\n它属于 EAGLE-3\n第三行\n第四行\n第五行\n第六行";
	const before = "开头内容\n结尾内容";
	const selStart = 5; // "开头内容\n" 之后
	const after = before.slice(0, selStart) + normalizeNewlines(raw) + before.slice(selStart);
	region("① 普通插入（事件早于写入）", before, after, selStart, 0, raw, [selStart, selStart + normalizeNewlines(raw).length]);
}

// 2) 事件晚于写入：before 已包含粘贴内容，游标在末尾
{
	const raw = "第一行\n第二行\n第三行\n第四行\n第五行\n第六行";
	const pasted = normalizeNewlines(raw);
	const after = "开头\n" + pasted + "\n结尾";
	const before = after; // 事件晚于写入
	const cursor = 3 + pasted.length;
	region("② 事件晚于写入（before===after）", before, after, cursor, 0, raw, [3, 3 + pasted.length]);
}

// 3) 替换选中内容
{
	const raw = "新文本很长的一段\n第二行\n第三行\n第四行\n第五行\n第六行";
	const needle = normalizeNewlines(raw);
	const before = "AAA[旧选中内容]BBB";
	const selStart = 3;
	const selLen = 5;
	const after = "AAA" + needle + "BBB";
	region("③ 替换选中内容", before, after, selStart, selLen, raw, [3, 3 + needle.length]);
}

// 4) CRLF 归一
{
	const raw = "甲\r\n乙\r\n丙\r\n丁\r\n戊\r\n己";
	const needle = normalizeNewlines(raw);
	const before = "头部\n";
	const after = before + needle;
	region("④ CRLF 归一", before, after, before.length, 0, raw, [before.length, before.length + needle.length]);
}

// 5) 重复文本：应命中最靠近光标的一处
{
	const raw = "重复行\n重复行\n重复行\n重复行\n重复行\n重复行";
	const needle = normalizeNewlines(raw);
	const head = "前置\n" + needle + "\n中间填充\n"; // 笔记里早先已有相同片段
	const before = head;
	const after = head + needle + "\n";
	const selStart = head.length; // 光标在第二处插入点
	region("⑤ 重复文本取最近一处", before, after, selStart, 0, raw, [head.length, head.length + needle.length]);
}

// 6) 无变化 → null
{
	region("⑥ 未写入 → null", "abc", "abc", 1, 0, "x\ny\nz\nw\nu\nv", null);
}

// 7) 粘贴内容被加了缩进（needle 找不到）→ diff 定位
{
	const raw = "- 列表一\n- 列表二\n- 列表三\n- 列表四\n- 列表五\n- 列表六";
	const indented = normalizeNewlines(raw).split("\n").join("\n  ");
	const before = "上文\n";
	const after = before + indented + "\n下文";
	// diff 区间会连带尾部相邻但不同的字符（\n下文），属可接受的轻微外扩
	region("⑦ 粘贴被加缩进（走 diff）", before, after, before.length, 0, raw, [before.length, after.length]);
}

// 8) 空粘贴内容
{
	region("⑧ 空 raw", "abc", "abcdef", 3, 0, "", [3, 6]);
}

// 9) 插入点极靠近文件末尾
{
	const raw = "1\n2\n3\n4\n5\n6";
	const needle = normalizeNewlines(raw);
	const before = "只有一行";
	const after = before + "\n" + needle;
	region("⑨ 追加到末尾", before, after, before.length + 1, 0, raw, [before.length + 1, after.length]);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
