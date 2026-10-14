import type { App } from "obsidian";
import { applyToString, buildIndex, buildReplacements, scanText } from "./linker";
import {
	applyExcalidraw,
	clipboardHasImageOrFile,
	elementRawText,
	ensureZeroLayoutFrontmatter,
	getLinkDecoration,
	hasPendingImages,
	sceneSignature,
	type ExcalidrawApi,
	type ExcalidrawElement,
} from "./excalidraw";
import { DEFAULT_SETTINGS, type SmartLinkerSettings } from "./types";
import { firstMeaningfulLine, snippetMatches } from "./utils";

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

// ── 最小 vault（与 test-scan 一致）────────────────────────────────────
const files = [
	{ path: "EAGLE-3.md", basename: "EAGLE-3", extension: "md", aliases: ["EAGLE"] },
	{ path: "Chunked-prefill.md", basename: "Chunked-prefill", extension: "md", aliases: [] as string[] },
];
const app = {
	vault: { getMarkdownFiles: () => files, getFiles: () => files },
	metadataCache: { getFileCache: (f: { aliases?: string[] }) => ({ frontmatter: { aliases: f.aliases ?? [] } }) },
} as unknown as App;
const S: SmartLinkerSettings = { ...DEFAULT_SETTINGS };
const index = buildIndex(app, S, null);

// ── mock ExcalidrawAutomate ─────────────────────────────────────────
function makeEa(initial: ExcalidrawElement[]) {
	const store = new Map(initial.map((e) => [e.id, { ...e }]));
	const calls: string[] = [];
	const ea: ExcalidrawApi = {
		getViewElements: () => [...store.values()],
		getViewSelectedElements: () => [],
		getElement: (id: string) => store.get(id),
		copyViewElementsToEAforEditing: (els) => {
			calls.push(`copy(${els.map((e) => e.id).join(",")})`);
		},
		refreshTextElementSize: (id) => {
			calls.push(`refresh(${id})`);
		},
		addElementsToView: async (...args) => {
			calls.push(`apply(${args.filter((a) => a !== undefined).join(",")})`);
			return true;
		},
		destroy: () => {
			calls.push("destroy");
		},
	};
	return { ea, calls, store };
}

/** 让文本元素走一遍「扫描 → 生成选择」的真实流程。 */
function select(el: ExcalidrawElement, targetIndex = 0) {
	const text = elementRawText(el);
	const cands = scanText(text, index, S, { protect: true, source: { element: el, text } });
	if (cands.length === 0) throw new Error(`no candidates for: ${text}`);
	return cands.map((c) => ({ candidate: c, targetIndex }));
}

console.log("工具函数：");
eq("firstMeaningfulLine 跳空行并截断", firstMeaningfulLine("\n\n  第一行内容很长很长很长很长\n第二行"), "第一行内容很长很长很长很长");
eq("firstMeaningfulLine 截断到 8", firstMeaningfulLine("abcdefghijklmn", 8), "abcdefgh");
eq("snippetMatches 命中", snippetMatches("前置\nsnippet在这里\n后置", "snippet"), true);
eq("snippetMatches 未命中", snippetMatches("完全无关", "snippet"), false);
eq("snippetMatches 空指纹", snippetMatches("abc", ""), false);

console.log("\n写入形式（forceAlias）：");
{
	const aliasDoc = "EAGLE 与 Chunked-prefill 联动";
	const ca = scanText(aliasDoc, index, S, { protect: true })[0];
	eq("别名命中写成别名形式", buildReplacements(aliasDoc, ca, 0, { forceAlias: true })[0].text, "[[EAGLE-3|EAGLE]]");

	const nameDoc = "EAGLE-3 是模型";
	const cn = scanText(nameDoc, index, S, { protect: true })[0];
	eq("同名时默认短形式", buildReplacements(nameDoc, cn, 0)[0].text, "[[EAGLE-3]]");
	eq("同名时强制别名形式", buildReplacements(nameDoc, cn, 0, { forceAlias: true })[0].text, "[[EAGLE-3|EAGLE-3]]");

	// 表格转义在 Excalidraw 下关闭
	const tableDoc = "| EAGLE | 说明 |";
	const tc = scanText(tableDoc, index, S, { protect: true })[0];
	eq("Excalidraw 不做表格转义", buildReplacements(tableDoc, tc, 0, { escapeTable: false })[0].text, "[[EAGLE-3|EAGLE]]");
	eq("Markdown 仍做表格转义", buildReplacements(tableDoc, tc, 0)[0].text, "[[EAGLE-3\\|EAGLE]]");
}

console.log("\n写回画板：只写 rawText，text/尺寸交给 Excalidraw 派生");
{
	const el: ExcalidrawElement = { id: "el1", type: "text", text: "EAGLE 与 Chunked-prefill 联动", rawText: "EAGLE 与 Chunked-prefill 联动" };
	const { ea, calls } = makeEa([el]);
	const before = el.text;
	await applyExcalidraw(ea, select(el), { forceAlias: true });
	const after = (ea as unknown as { getElement: (id: string) => ExcalidrawElement }).getElement("el1");
	eq("rawText 写入 [[笔记名|原文]]", after.rawText, "[[EAGLE-3|EAGLE]] 与 [[Chunked-prefill|Chunked-prefill]] 联动");
	eq("originalText 同步", after.originalText, after.rawText);
	eq("不写 text（由 Excalidraw 回写画布展示文字）", after.text, before);
	eq("不调 refreshTextElementSize", calls.some((c) => c.startsWith("refresh")), false);
	eq("写回参数：不重定位/保存/不置顶/restore/IMMEDIATELY", calls.includes("apply(false,true,false,true,IMMEDIATELY)"), true);
	eq("释放 EA 实例", calls.includes("destroy"), true);
}

console.log("\n写回画板：失效 [[链接]] 重写");
{
	const el: ExcalidrawElement = { id: "el2", type: "text", text: "[[EAGLE]]", rawText: "[[EAGLE]]" };
	const { ea, calls } = makeEa([el]);
	const n = await applyExcalidraw(ea, select(el), { forceAlias: false });
	const after = (ea as unknown as { getElement: (id: string) => ExcalidrawElement }).getElement("el2");
	eq("返回改动的元素数", n, 1);
	eq("rawText 重写为 [[EAGLE-3|EAGLE]]", after.rawText, "[[EAGLE-3|EAGLE]]");
	eq("仍未触碰 text", after.text, "[[EAGLE]]");
	eq("仍未调 refreshTextElementSize", calls.some((c) => c.startsWith("refresh")), false);
}

console.log("\n写回画板：多行文本 + 别名替换只改一处");
{
	const src = "第一行 EAGLE\n第二行\n第三行\n第四行\n第五行 Chunked-prefill";
	const el: ExcalidrawElement = { id: "el3", type: "text", text: src, rawText: src };
	const { ea } = makeEa([el]);
	const cands = scanText(src, index, S, { protect: true, source: { element: el, text: src } });
	await applyExcalidraw(ea, cands.map((c) => ({ candidate: c, targetIndex: 0 })), { forceAlias: true });
	const after = (ea as unknown as { getElement: (id: string) => ExcalidrawElement }).getElement("el3");
	eq("两处链接都写入", after.rawText, "第一行 [[EAGLE-3|EAGLE]]\n第二行\n第三行\n第四行\n第五行 [[Chunked-prefill|Chunked-prefill]]");
	eq("text 保持原样", after.text, src);
}

console.log("\n写回画板：绑定文本（矩形内文字）保持原样");
{
	const container: ExcalidrawElement = { id: "box1", type: "rectangle", text: "", rawText: "" };
	const bound: ExcalidrawElement = { id: "t1", type: "text", containerId: "box1", text: "EAGLE\n换行后的展示文本", rawText: "EAGLE" };
	const { ea } = makeEa([container, bound]);
	await applyExcalidraw(ea, select(bound), { forceAlias: true });
	const after = (ea as unknown as { getElement: (id: string) => ExcalidrawElement }).getElement("t1");
	eq("rawText 写入链接", after.rawText, "[[EAGLE-3|EAGLE]]");
	eq("绑定文本的换行展示文本未被破坏", after.text, "EAGLE\n换行后的展示文本");
}

console.log("\n链接装饰生效值（frontmatter 覆盖优先于插件设置）：");
{
	const mkApp = (
		exSettings: Record<string, unknown> | null,
		frontmatter: Record<string, unknown> | null,
	): App =>
		({
			vault: { getMarkdownFiles: () => files, getFiles: () => files },
			metadataCache: { getFileCache: () => (frontmatter ? { frontmatter } : {}) },
			plugins: { plugins: exSettings ? { "obsidian-excalidraw-plugin": { settings: exSettings } } : {} },
		}) as unknown as App;
	const f = { path: "a.excalidraw.md" } as never;

	const none = getLinkDecoration(mkApp(null, null), null);
	eq("无 Excalidraw 插件 → 未知来源", [none.brackets, none.prefix, none.source], [false, "", "unknown"]);

	const plug = getLinkDecoration(mkApp({ showLinkBrackets: true, linkPrefix: "📍" }, null), f);
	eq("取插件全局设置", [plug.brackets, plug.prefix, plug.source], [true, "📍", "plugin"]);

	const off = getLinkDecoration(mkApp({ showLinkBrackets: true, linkPrefix: "📍" }, { "excalidraw-link-brackets": false, "excalidraw-link-prefix": "" }), f);
	eq("画板 frontmatter 覆盖为关", [off.brackets, off.prefix, off.source], [false, "", "frontmatter"]);

	const onlyBrackets = getLinkDecoration(mkApp({ showLinkBrackets: true, linkPrefix: "📍" }, { "excalidraw-link-brackets": false }), f);
	eq("只覆盖方括号时前缀仍取插件设置", [onlyBrackets.brackets, onlyBrackets.prefix], [false, "📍"]);
}

console.log("\n排版零变化 frontmatter 写入：");
{
	const captured: Record<string, unknown>[] = [];
	const app2 = {
		fileManager: { processFrontMatter: async (_f: unknown, fn: (fm: Record<string, unknown>) => void) => fn(captured[0]) },
	} as unknown as App;
	const file = { path: "a.excalidraw.md" } as never;

	captured[0] = { tags: ["excalidraw"] };
	eq("首次写入判定为已改动", await ensureZeroLayoutFrontmatter(app2, file), true);
	eq("写入的两个键", [captured[0]["excalidraw-link-brackets"], captured[0]["excalidraw-link-prefix"]], [false, ""]);
	eq("保留原有 frontmatter", captured[0].tags, ["excalidraw"]);

	eq("已是目标值时不改动", await ensureZeroLayoutFrontmatter(app2, file), false);
}

console.log("\n元素原文取值：");
{
	eq("优先 rawText", elementRawText({ id: "a", type: "text", text: "展示", rawText: "原文" }), "原文");
	eq("rawText 为空退化到 text", elementRawText({ id: "a", type: "text", text: "展示", rawText: "" }), "展示");
	eq("无 rawText 字段时用 text", elementRawText({ id: "a", type: "text", text: "展示" }), "展示");
}

console.log("\napplyToString 倒序拼接：");
{
	const src = "a EAGLE b";
	const cands = scanText(src, index, S, { protect: true });
	const reps = buildReplacements(src, cands[0], 0, { forceAlias: true });
	eq("替换结果", applyToString(src, reps), "a [[EAGLE-3|EAGLE]] b");
}

console.log("\n剪贴板含图片/文件判定（带图片时本插件不介入）：");
{
	const mk = (files: unknown[], items: unknown[]): DataTransfer => ({ files, items } as unknown as DataTransfer);
	eq("files 非空 → true", clipboardHasImageOrFile(mk([{}], [])), true);
	eq("items 里有 kind=file → true", clipboardHasImageOrFile(mk([], [{ kind: "file", type: "image/png" }])), true);
	eq("纯文本 → false", clipboardHasImageOrFile(mk([], [{ kind: "string", type: "text/plain" }])), false);
	eq("空 items → false", clipboardHasImageOrFile(mk([], [])), false);
	eq("null → false", clipboardHasImageOrFile(null), false);
	const boom = {
		get files(): never {
			throw new Error("denied");
		},
	} as unknown as DataTransfer;
	eq("读取抛错时按「没有图片」处理", clipboardHasImageOrFile(boom), false);
}

console.log("\n未就绪图片检测（阻止写回冲掉正在插入的图片）：");
{
	eq("普通文本元素 → false", hasPendingImages([{ id: "t", type: "text", text: "hi" }]), false);
	eq("图片已就绪 → false", hasPendingImages([{ id: "i", type: "image", status: "saved", fileId: "f1" }]), false);
	eq("图片 status=pending → true", hasPendingImages([{ id: "i", type: "image", status: "pending", fileId: "f1" }]), true);
	eq("图片 status=loading → true", hasPendingImages([{ id: "i", type: "image", status: "loading", fileId: "f1" }]), true);
	eq("图片 status=error → true", hasPendingImages([{ id: "i", type: "image", status: "error", fileId: "f1" }]), true);
	eq("图片缺 fileId → true", hasPendingImages([{ id: "i", type: "image", status: "saved" }]), true);
	eq("已删除的 pending 图片忽略 → false", hasPendingImages([{ id: "i", type: "image", status: "pending", isDeleted: true }]), false);
}

console.log("\n场景指纹（连续两次一致才允许写回）：");
{
	const a = [
		{ id: "t1", type: "text", version: 1 },
		{ id: "i1", type: "image", version: 3 },
	];
	const b = [
		{ id: "i1", type: "image", version: 3 },
		{ id: "t1", type: "text", version: 1 },
	];
	eq("元素顺序无关 → 指纹相同", sceneSignature(a), sceneSignature(b));
	eq("元素版本变化 → 指纹不同", sceneSignature(a) === sceneSignature([{ id: "t1", type: "text", version: 2 }, { id: "i1", type: "image", version: 3 }]), false);
	eq("新增元素 → 指纹不同", sceneSignature(a) === sceneSignature([...a, { id: "n1", type: "text", version: 1 }]), false);
	eq("已删除元素不参与", sceneSignature([{ id: "x", type: "text", version: 1, isDeleted: true }]), sceneSignature([]));
	eq("空场景", sceneSignature([]), "0|");
}

console.log("\n写回加固：EA 取不到元素副本时不写、不抛（宁可跳过，也不写坏画板）");
{
	const el: ExcalidrawElement = { id: "el9", type: "text", text: "EAGLE", rawText: "EAGLE" };
	const ea = {
		getViewElements: () => [el],
		getViewSelectedElements: () => [],
		getElement: () => undefined,
		copyViewElementsToEAforEditing: () => {},
		addElementsToView: async () => true,
	} as unknown as ExcalidrawApi;
	eq("返回 0", await applyExcalidraw(ea, select(el), { forceAlias: true }), 0);
	eq("view 里的元素未被改动", el.rawText, "EAGLE");
}

console.log("\n写回加固：元素是冻结对象时也不抛（旧实现的回退写入会在这里炸）");
{
	const el = Object.freeze({ id: "elF", type: "text", text: "EAGLE", rawText: "EAGLE" }) as ExcalidrawElement;
	const ea = {
		getViewElements: () => [el],
		getViewSelectedElements: () => [],
		getElement: () => undefined,
		copyViewElementsToEAforEditing: () => {},
		addElementsToView: async () => true,
	} as unknown as ExcalidrawApi;
	let threw = false;
	let n = -1;
	try {
		n = await applyExcalidraw(ea, select(el), { forceAlias: true });
	} catch {
		threw = true;
	}
	eq("不抛异常", threw, false);
	eq("返回 0", n, 0);
	eq("冻结元素保持原样", el.rawText, "EAGLE");
}

console.log("\n写回加固：copyViewElementsToEAforEditing 抛错 → 返回 0，不抛");
{
	const el: ExcalidrawElement = { id: "elC", type: "text", text: "EAGLE", rawText: "EAGLE" };
	const ea = {
		getViewElements: () => [el],
		getViewSelectedElements: () => [],
		getElement: () => el,
		copyViewElementsToEAforEditing: () => {
			throw new Error("boom");
		},
		addElementsToView: async () => true,
	} as unknown as ExcalidrawApi;
	let threw = false;
	let n = -1;
	try {
		n = await applyExcalidraw(ea, select(el), { forceAlias: true });
	} catch {
		threw = true;
	}
	eq("不抛异常", threw, false);
	eq("返回 0", n, 0);
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
