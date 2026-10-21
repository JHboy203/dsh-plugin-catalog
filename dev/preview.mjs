/**
 * dev/preview.mjs — 把面板**真实组件树 + 真实 CSS** 序列化成静态 HTML，供截图看版式。
 *
 * 为什么需要它：无头自检（render-check）只能验结构/文案，验不了**版式**——
 * 「浮窗真的居中吗」「卡片网格会不会被挤成一列」「徽章在窄卡片里会不会换行溢出」，
 * 这些只能看渲染结果。本机没有 jsdom/linkedom，也没有独立的 react 包，
 * 所以这里用最小 React 替身渲染一遍，再把虚拟树序列化成 DOM 字符串，
 * CSS 直接取 `apply()` 注入的那一份（同一个字符串，不是另抄一份）。
 *
 * 用法：node dev/preview.mjs [outDir]
 *   → 生成 preview-panel.html / preview-modal.html / preview-plan.html
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceRoot } from "../lib/hostinfo.js";

/* 默认输出到**工作区**（不是插件目录）：插件目录在沙箱里写不进，而且预览产物不该进仓 */
const outDir = process.argv[2] || join(workspaceRoot() || process.cwd(), ".tmp-catalog-probe", "preview");
mkdirSync(outDir, { recursive: true });

/* ── 最小 React 替身（与 render-check 同一套语义） ── */
let hookIndex = 0;
const hookStates = [];
const ReactStub = {
	createElement(type, props, ...children) {
		return { type, props: { ...(props || {}), children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) } };
	},
	useState(initial) {
		const index = hookIndex++;
		if (!(index in hookStates)) hookStates[index] = typeof initial === "function" ? initial() : initial;
		return [hookStates[index], (next) => { hookStates[index] = typeof next === "function" ? next(hookStates[index]) : next; }];
	},
	useEffect(fn) { /* 预览不需要副作用 */ },
	useMemo(fn) { return fn(); },
	useRef(value) { const index = hookIndex++; if (!(index in hookStates)) hookStates[index] = { current: value }; return hookStates[index]; },
};
function resetHooks() {
	hookIndex = 0;
	hookStates.length = 0;
}

/* ── 加载 client.js（同 realm，顺带抓住注入的 CSS） ── */
let exported = null;
let capturedCss = "";
const fakeDocument = {
	head: { appendChild(node) { if (node && node.textContent) capturedCss += node.textContent; } },
	createElement() { return { setAttribute() {}, remove() {}, style: {}, textContent: "" }; },
	addEventListener() {},
	removeEventListener() {},
};
const windowStub = {
	__ModuleLoader__: {
		load(spec) {
			exported = spec.factory((name) => {
				if (name === "react") return ReactStub;
				throw new Error("unexpected require: " + name);
			});
		},
	},
};
const clientSource = (await import("node:fs")).readFileSync(new URL("../client.js", import.meta.url), "utf8");
new Function("window", "document", "fetch", "setTimeout", "clearTimeout", "console", clientSource)(
	windowStub,
	fakeDocument,
	async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
	() => 0,
	() => {},
	console,
);
const T = exported.__test;

/* 触发 apply() 以注入 CSS（slots 只记录、不渲染） */
T.apply({
	effect(fn) { fn(); },
	layout: { selectPanel() {} },
	slots: { inject() {}, register() { return () => {}; } },
});

/* ── 虚拟树 → HTML ── */
const VOID_TAGS = new Set(["input", "img", "br", "hr", "meta", "link"]);
const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function styleToCss(style) {
	if (!style || typeof style !== "object") return "";
	return Object.entries(style)
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([key, value]) => `${key.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${typeof value === "number" ? value + "px" : value}`)
		.join(";");
}

function serialize(node) {
	if (node === null || node === undefined || node === false || node === true) return "";
	if (typeof node === "string" || typeof node === "number") return escapeHtml(node);
	if (Array.isArray(node)) return node.map(serialize).join("");
	if (typeof node !== "object" || !node.props) return "";
	if (typeof node.type === "function") {
		resetHooks();
		return serialize(node.type(node.props));
	}
	const tag = typeof node.type === "string" ? node.type : "div";
	const props = node.props || {};

	/* ★ <select> 的当前值不是属性而是"哪个 option 被选中"：
	   不处理的话浏览器永远显示第一个选项，截图上看起来像"排序没生效"（预览保真度问题）。 */
	let children = props.children;
	if (tag === "select" && props.value !== undefined) {
		const mark = (child) => {
			if (Array.isArray(child)) return child.map(mark);
			if (child && typeof child === "object" && child.props && child.type === "option") {
				return { ...child, props: { ...child.props, selected: String(child.props.value) === String(props.value) } };
			}
			return child;
		};
		children = mark(children);
	}

	const attrs = [];
	for (const [key, value] of Object.entries(props)) {
		if (key === "children" || value === undefined || value === null || typeof value === "function") continue;
		if (tag === "select" && (key === "value" || key === "onChange")) continue;
		if (key === "className") attrs.push(`class="${escapeHtml(value)}"`);
		else if (key === "style") attrs.push(`style="${escapeHtml(styleToCss(value))}"`);
		else if (key === "value") attrs.push(`value="${escapeHtml(value)}"`);
		else if (key === "checked") { if (value) attrs.push("checked"); }
		else if (key === "selected") { if (value) attrs.push("selected"); }
		else if (key === "disabled") { if (value) attrs.push("disabled"); }
		else if (typeof value === "boolean") { if (value) attrs.push(key); }
		else attrs.push(`${key}="${escapeHtml(value)}"`);
	}
	const open = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
	if (VOID_TAGS.has(tag)) return open;
	return open + serialize(children) + `</${tag}>`;
}

/* ── 假数据（形同真机：127 个条目里的代表样本） ── */
function item(overrides) {
	return {
		id: "plugin:dsh-screenshot",
		kind: "plugin",
		name: "dsh-screenshot",
		title: "dsh-screenshot",
		version: "34.0.0",
		descriptionEn: "QQ-like screenshot tool with host-side capture, offline OCR and long screenshots.",
		descriptionZh: "仿 QQ 截图：宿主抓屏、离线 OCR、长截图与标注。",
		source: "self",
		sourceWhy: ["link/junction 安装，源目录就是工作区里的本地目录"],
		askUser: false,
		enabled: true,
		repoUrl: "https://github.com/JHboy203/dsh-screenshot",
		createdAt: Date.now() - 86400000 * 21,
		calls: 12345,
		errors: 7,
		lastUsed: Date.now() - 3600000,
		sessions: 42,
		subagentCalls: 500,
		toolCount: 8,
		tags: { purpose: ["screenshot"], context: ["web-gui"], origin: ["src-self"] },
		...overrides,
	};
}

const tags = {
	all: [
		{ id: "screenshot", dimension: "purpose", label: "截图", gloss: "抓屏与 OCR", builtin: true },
		{ id: "ops", dimension: "purpose", label: "运维", gloss: "体检与清理", builtin: true },
		{ id: "game", dimension: "purpose", label: "游戏", gloss: "Minecraft 相关", builtin: true },
		{ id: "web-gui", dimension: "context", label: "Web GUI", gloss: "作用在界面上", builtin: true },
		{ id: "astrbot", dimension: "context", label: "AstrBot", gloss: "QQ 机器人链路", builtin: true },
		{ id: "c-1", dimension: "purpose", label: "视频剪辑", gloss: "处理视频素材", builtin: false },
	],
	assignments: {},
	prompt: "",
};

const entries = [
	item({}),
	item({ id: "plugin:@anionex/dsh-vision-toolkit", name: "@anionex/dsh-vision-toolkit", source: "third", calls: 200, subagentCalls: 0, descriptionZh: "视觉工具包：看图、定位、长截图 OCR。", descriptionEn: "Vision toolkit.", tags: { purpose: ["screenshot"], context: ["web-gui"], origin: [] } }),
	item({ id: "plugin:dsh-ops", name: "dsh-ops", source: "third", calls: 4783, subagentCalls: 0, descriptionZh: "本机命令与文件操作工具集（bash / grep / glob 等）。", descriptionEn: "Local command and filesystem operations.", tags: { purpose: ["ops"], context: ["workspace"], origin: [] } }),
	item({ id: "plugin:dsh-mc-forensics", name: "dsh-mc-forensics", source: "self", calls: 197, subagentCalls: 40, descriptionZh: "Minecraft 服务端取证：世界库、玩家背包、RDP 远程读取。", descriptionEn: "Bedrock server forensics over RDP.", tags: { purpose: ["game", "ops"], context: ["minecraft", "remote"], origin: [] } }),
	item({ id: "plugin:dsh-ofm-ops", name: "dsh-ofm-ops", source: "pending", askUser: true, calls: 3, descriptionZh: "", descriptionEn: "Some plugin.", sourceWhy: ["从 npm 安装", "工作区 DSH-Plugin/ 下有同名目录，可能是本地改过的副本，需你确认"], tags: { purpose: [], context: [], origin: [] } }),
	item({ id: "skill:vex-ops", kind: "skill", name: "vex-ops", calls: 19, subagentCalls: 0, sessions: 0, descriptionZh: "维护 Vex：QQ 机器人链路。", descriptionEn: "", lastUsed: Date.now() - 86400000, tags: { purpose: ["game"], context: ["astrbot"], origin: [] } }),
];

const state = {
	ok: true,
	build: { label: "0.1.0 · 2026-10-21 01:42" },
	dataDir: "D:\\信息库\\AI工作区\\.dsh-plugin-catalog",
	settings: { sessionsPageSize: 20 },
	tags,
	catalogMeta: { counts: { plugins: 71, skills: 56 }, errors: [] },
	stats: { ready: true, stale: false, meta: { builtAt: Date.now() - 60000, windowDays: 90, calls: 53774, sessions: 772 } },
	attribution: { total: 196, byDescription: 193, byName: 1, host: 2, unknown: 0 },
	job: { running: false, kind: "", progress: { phase: "idle", done: 0, total: 0 } },
	weekly: { lastGapAt: 0, lastSecurityAt: 0 },
	weeklyDue: { gap: true, security: true },
	reports: { gap: { repos: 0 }, security: { repos: 0 } },
	entries,
	hostCore: { id: "host-core", kind: "host", name: "宿主核心工具", calls: 38000, tools: [{ name: "pwsh", calls: 13238, owner: "@deepseek-ai/dsh-tool-pwsh" }, { name: "read", calls: 7846, owner: "@deepseek-ai/dsh-tool-fs" }, { name: "edit", calls: 8161, owner: "@deepseek-ai/dsh-tool-fs" }] },
	totals: { plugins: 71, skills: 56, calls: 17544, errors: 7, subagentCalls: 540, hostCoreCalls: 38000, bySource: { official: 7, self: 23, third: 40, hybrid: 0, pending: 1 }, askUser: 1 },
	publishing: { skillsRepo: "my-dsh-skills", skillsStageDir: "x" },
};

const detail = {
	ok: true,
	item: { ...entries[0], tags: { purpose: ["screenshot", "c-1"], context: ["web-gui"], origin: ["src-self"] } },
	tools: [
		{ name: "screenshot", calls: 8000, errors: 2, avgMs: 420, lastUsed: Date.now() - 3600000, sessions: 30 },
		{ name: "shot_probe", calls: 4345, errors: 5, avgMs: 1200, lastUsed: Date.now() - 7200000, sessions: 12 },
	],
	sessions: {
		items: [
			{ id: "session-a", title: "TKS后台10", calls: 300, isSubagent: false, depth: 0, parentTitle: "", lastAt: Date.now() - 3600000 },
			{ id: "session-b", title: "子代理-截图验收", calls: 120, isSubagent: true, depth: 1, parentTitle: "TKS后台10", lastAt: Date.now() - 7200000 },
			{ id: "session-c", title: "插件目录面板", calls: 80, isSubagent: false, depth: 0, parentTitle: "", lastAt: Date.now() - 900000 },
		],
		page: 1,
		pages: 3,
		total: 42,
		pageSize: 20,
		pageSizes: [10, 20, 50, 100],
	},
	descendants: 2,
	statsLimited: false,
};

const plan = {
	planId: "plan-preview",
	login: "JHboy203",
	summary: { create: 2, update: 0, upToDate: 24, blocked: 1, needsAttention: 0, readmeNeedingEnglish: 22 },
	items: [
		{ id: "plugin:dsh-plugin-catalog", kind: "plugin", name: "dsh-plugin-catalog", repo: "dsh-plugin-catalog", source: "self", action: "create", reasons: ["还没有 origin，将新建私有仓 JHboy203/dsh-plugin-catalog", "需要生成/更新英文 README（还没有英文版）"], scan: { files: 26, worst: "clean", hits: [] } },
		{ id: "plugin:dsh-screenshot", kind: "plugin", name: "dsh-screenshot", repo: "dsh-screenshot", source: "self", action: "up-to-date", reasons: ["本地 HEAD 与远端 main 一致（sha 相同）"], scan: { files: 120, worst: "clean", hits: [] } },
		{
			id: "plugin:dsh-github-backup",
			kind: "plugin",
			name: "dsh-github-backup",
			repo: "dsh-github-backup",
			source: "self",
			action: "blocked-secrets",
			reasons: ["扫描命中 1 条（最高 critical）—— 本仓不推，先处理"],
			scan: { files: 40, worst: "critical", hits: [{ kind: "content", severity: "critical", file: "dev/hosttest.mjs", line: 39, rule: "private-key-block", sample: "----…****** (len=35)", plain: "像测试夹具里的假密钥，可忽略；如果它是从真实配置复制来的，就要改。" }] },
		},
	],
	uploadResult: null,
};

/* ── 渲染三个版式 ── */
function renderPage(name, title, bodyHtml, extraHead = "") {
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
:root{
  --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-2:#f7f8fa; --dsw-alias-bg-layer-3:#eef0f3;
  --dsw-alias-label-primary:#1f2937; --dsw-alias-label-secondary:#6b7280;
  --dsw-alias-border:#e5e7eb; --dsw-alias-border-strong:#d0d5dd;
  --dsw-alias-brand-primary:#3964fe; --dsw-alias-state-warn-primary:#d89614;
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI",system-ui,"Microsoft YaHei",sans-serif;
  background:#fbfbfc;color:#1f2937;padding:16px}
.frame{max-width:1180px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden}
.frame-head{padding:10px 16px;border-bottom:1px solid #eef0f3;font-size:12px;color:#6b7280}
${extraHead}
${capturedCss}
</style></head>
<body><div class="frame"><div class="frame-head">${escapeHtml(title)}</div>${bodyHtml}</div></body></html>`;
}

const cases = [
	{ file: "preview-panel.html", title: "面板列表（真实组件树 + 真实 CSS，沙箱预览）", setup: () => { T.store.data = state; T.store.loading = false; T.store.error = null; T.store.open = null; T.store.plan = null; T.store.query = ""; T.store.source = "any"; T.store.kind = "all"; T.store.sort = "calls"; return T.Panel({}); } },
	{ file: "preview-search.html", title: "搜索「vision」+ 排序「名称」", setup: () => { T.store.data = state; T.store.query = "vision"; T.store.sort = "name"; return T.Panel({}); } },
	{ file: "preview-modal.html", title: "条目浮窗（居中、点外部关闭）", setup: () => { T.store.data = state; T.store.query = ""; T.store.source = "any"; T.store.kind = "all"; T.store.sort = "calls"; T.store.open = { id: "plugin:dsh-screenshot", page: 1, pageSize: 20 }; T.store.detail = detail; return T.EntryModal({}); } },
	{ file: "preview-plan.html", title: "上传计划浮窗（密钥命中 + 确认放行）", setup: () => { T.store.plan = plan; T.store.open = null; T.store.detail = null; return T.PlanModal({}); } },
];

for (const item of cases) {
	resetHooks();
	const tree = item.setup();
	const html = renderPage(item.file, item.title, serialize(tree));
	writeFileSync(join(outDir, item.file), html, "utf8");
	console.log("wrote", join(outDir, item.file), (html.length / 1024).toFixed(0) + " KB");
}

/* 顺手把一份“空数据”也渲染出来，确认空态不塌 */
resetHooks();
T.store.data = { ...state, entries: [], hostCore: { calls: 0, tools: [] }, totals: { plugins: 0, skills: 0, bySource: {}, askUser: 0, calls: 0, errors: 0, subagentCalls: 0 } };
const emptyHtml = renderPage("preview-empty.html", "空数据（不应塌版）", serialize(T.Panel({})));
writeFileSync(join(outDir, "preview-empty.html"), emptyHtml, "utf8");
console.log("wrote", join(outDir, "preview-empty.html"));

console.log("");
console.log("CSS 注入长度:", capturedCss.length, "chars");
console.log("预览目录:", outDir);
