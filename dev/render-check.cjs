/**
 * dev/render-check.cjs — 界面层自检（**不需要 DSH、不需要浏览器**）。
 *
 * 做法：给 client.js 一个极小的 React 替身（只实现 useState/useEffect/useMemo/useRef），
 * 把 __test 里的组件真的渲染一遍，然后对输出的虚拟树断言：
 *   · 卡片上有没有名字/中文简介/英文原文/来源徽章/调用次数/时间
 *   · 搜索与四种排序是否真的改变结果顺序
 *   · 浮窗是否渲染出「分工具次数 / 会话列表（含昵称与子代理标记）/ 标签 / 来源依据」
 *   · 上传计划浮窗是否把密钥命中与「因密钥跳过」摊开
 *   · 空数据、坏数据时是否给出人话而不是崩
 *
 * 用法：node dev/render-check.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		return;
	}
	failed += 1;
	failures.push(name + (detail ? " — " + detail : ""));
}

/* ── 微型 React ── */

let hookIndex = 0;
let hookStates = [];
let effects = [];

const ReactStub = {
	createElement(type, props, ...children) {
		/* children 必须挂在 props.children 上 —— 与真实 React 一致，
		   否则遍历器找不到子树（调试时踩到过：面板渲染出来是一片空）。 */
		return { type, props: { ...(props || {}), children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) } };
	},
	useState(initial) {
		const index = hookIndex++;
		if (!(index in hookStates)) hookStates[index] = typeof initial === "function" ? initial() : initial;
		const setter = (next) => {
			hookStates[index] = typeof next === "function" ? next(hookStates[index]) : next;
		};
		return [hookStates[index], setter];
	},
	useEffect(fn) {
		effects.push(fn);
	},
	useMemo(fn) {
		return fn();
	},
	useRef(value) {
		const index = hookIndex++;
		if (!(index in hookStates)) hookStates[index] = { current: value };
		return hookStates[index];
	},
};

function resetHooks() {
	hookIndex = 0;
	hookStates = [];
	effects = [];
}

/* ── 加载 client.js ── */

let exported = null;
const sandbox = {
	window: {
		__ModuleLoader__: {
			load(spec) {
				exported = spec.factory((name) => {
					if (name === "react") return ReactStub;
					throw new Error("unexpected require: " + name);
				});
			},
		},
	},
	document: {
		head: { appendChild() {} },
		createElement: () => ({ setAttribute() {}, remove() {}, style: {} }),
		addEventListener() {},
		removeEventListener() {},
	},
	fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
	console,
	setTimeout: () => 0,
	clearTimeout: () => {},
	Date,
	Math,
	JSON,
	Number,
	String,
	Boolean,
	Array,
	Object,
	Set,
	Map,
	encodeURIComponent,
};

const source = fs.readFileSync(path.join(__dirname, "..", "client.js"), "utf8");
/* ★ 用 new Function 在**同一个 realm**里执行：
   走 vm.runInNewContext 的话，数组来自另一个 realm，外层的 Array.isArray 会返回 false,
   遍历虚拟树时会静默停住 —— 于是所有断言都"找不到文本"（这个坑真实踩过一次）。 */
const runClient = new Function("window", "document", "fetch", "setTimeout", "clearTimeout", "console", source);
runClient(sandbox.window, sandbox.document, sandbox.fetch, sandbox.setTimeout, sandbox.clearTimeout, console);
ok("client.js 能被 ModuleLoader 加载", Boolean(exported));
ok("导出了 apply", typeof exported.apply === "function");
ok("inject 声明了 slots 与 layout", exported.inject.includes("slots") && exported.inject.includes("layout"), JSON.stringify(exported.inject));
ok("面板 id 是 catalog", exported.__test.PANEL_ID === "catalog");
ok("BUILD 号存在", typeof exported.__test.BUILD === "string" && exported.__test.BUILD.length > 0);

const T = exported.__test;

/* ── 渲染工具 ── */

function render(Component, props) {
	resetHooks();
	return Component(props || {});
}

/** 深度遍历虚拟树，收集所有文本。 */
function textsOf(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) textsOf(child, out);
		return out;
	}
	if (typeof node === "object" && node.props) {
		const { children, ...rest } = node.props;
		for (const value of Object.values(rest)) {
			if (typeof value === "string" && value.length < 200) out.push(value);
		}
		if (children) textsOf(children, out);
	}
	return out;
}

function findAll(node, predicate, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, predicate, out);
		return out;
	}
	if (typeof node === "object" && node.props) {
		if (predicate(node)) out.push(node);
		findAll(node.props.children, predicate, out);
	}
	return out;
}

/** 递归调用所有函数组件（因为我们的 createElement 不做渲染）。 */
function expand(node, depth = 0) {
	if (depth > 30 || node === null || node === undefined || node === false) return node;
	if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1));
	if (typeof node === "object" && node.props) {
		if (typeof node.type === "function") {
			const rendered = render(node.type, node.props);
			return expand(rendered, depth + 1);
		}
		return { type: node.type, props: { ...node.props, children: expand(node.props.children, depth + 1) } };
	}
	return node;
}

/* ── 造一份假状态 ── */

function makeItem(overrides) {
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
		createdAt: 1760000000000,
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

const data = {
	ok: true,
	build: { label: "0.1.0 · 2026-10-21 01:30" },
	dataDir: "D:\\信息库\\AI工作区\\.dsh-plugin-catalog",
	settings: { sessionsPageSize: 20 },
	tags: {
		all: [
			{ id: "screenshot", dimension: "purpose", label: "截图", gloss: "抓屏与 OCR", builtin: true },
			{ id: "ops", dimension: "purpose", label: "运维", gloss: "体检与清理", builtin: true },
			{ id: "web-gui", dimension: "context", label: "Web GUI", gloss: "作用在界面上", builtin: true },
			{ id: "c-1", dimension: "purpose", label: "视频剪辑", gloss: "处理视频素材", builtin: false },
		],
		assignments: {},
	},
	catalogMeta: { counts: { plugins: 70, skills: 55 }, errors: [] },
	stats: { ready: true, stale: false, meta: { builtAt: Date.now() - 60000, windowDays: 90, calls: 53589, sessions: 772 } },
	attribution: { byDescription: 40, byName: 5, host: 20, unknown: 3 },
	job: { running: false, kind: "", progress: { phase: "idle", done: 0, total: 0 } },
	weekly: { lastGapAt: 0, lastSecurityAt: 0 },
	weeklyDue: { gap: true, security: true },
	reports: { gap: { repos: 0 }, security: { repos: 0 } },
	entries: [
		makeItem({}),
		makeItem({ id: "plugin:@anionex/dsh-vision-toolkit", name: "@anionex/dsh-vision-toolkit", source: "third", calls: 200, subagentCalls: 0, descriptionZh: "视觉工具包：看图、定位、长截图 OCR。", descriptionEn: "Vision toolkit." }),
		makeItem({ id: "skill:vex-ops", kind: "skill", name: "vex-ops", calls: 19, subagentCalls: 0, sessions: 0, descriptionZh: "维护 Vex：QQ 机器人链路。", descriptionEn: "", lastUsed: Date.now() - 86400000, tags: { purpose: ["game"], context: ["astrbot"], origin: ["src-self"] } }),
		makeItem({ id: "plugin:dsh-ofm-ops", name: "dsh-ofm-ops", source: "pending", askUser: true, calls: 3, descriptionZh: "", descriptionEn: "Some plugin.", sourceWhy: ["从 npm 安装", "工作区 DSH-Plugin/ 下有同名目录，可能是本地改过的副本，需你确认"] }),
	],
	hostCore: { id: "host-core", kind: "host", name: "宿主核心工具", calls: 38000, tools: [{ name: "pwsh", calls: 13000 }, { name: "read", calls: 8000 }, { name: "edit", calls: 7000 }] },
	totals: { plugins: 70, skills: 55, calls: 13000, errors: 7, subagentCalls: 500, hostCoreCalls: 38000, bySource: { official: 7, self: 22, third: 40, hybrid: 1, pending: 1 }, askUser: 1 },
	publishing: { skillsRepo: "my-dsh-skills", skillsStageDir: "x" },
};

/* ① 列表：卡片内容 */
T.store.data = data;
T.store.loading = false;
T.store.error = null;
T.store.open = null;
T.store.plan = null;

const panel = expand(render(T.Panel, {}));
const panelText = textsOf(panel).join(" | ");

ok("面板显示标题「插件目录」", panelText.includes("插件目录"));
ok("显示汇总（插件/Skill 数量）", panelText.includes("插件 70") || panelText.includes("70"));
ok("卡片显示插件名", panelText.includes("dsh-screenshot"));
ok("卡片显示中文简介", panelText.includes("仿 QQ 截图"));
ok("卡片显示英文原文（小字）", panelText.includes("QQ-like screenshot tool"));
ok("卡片显示来源徽章「自写」", panelText.includes("自写"));
ok("卡片显示调用次数（万为单位）", panelText.includes("1.2万") || panelText.includes("12345"));
ok("卡片显示「含子代理」", panelText.includes("含子代理"));
ok("卡片显示标签", panelText.includes("截图"));
ok("待标记条目显示「待确认」", panelText.includes("待确认"));
ok("有搜索框", findAll(panel, (node) => node.props && typeof node.props.placeholder === "string" && node.props.placeholder.includes("搜索")).length > 0);
ok("有四种排序选项", T.SORTS.length === 4 && T.SORTS.map((s) => s.id).join(",") === "calls,recent,time,name");
ok("有来源筛选（官方/自写/第三方/混血/待标记）", ["全部", "官方", "自写", "第三方", "混血", "待标记"].every((label) => panelText.includes(label)));
ok("宿主核心工具单列", panelText.includes("宿主核心工具"));
ok("宿主核心说明里写明「不把这些量算到插件头上」", panelText.includes("不把这些量算到插件头上"));
ok("页脚声明只存会话 ID/昵称/次数、不含对话文本", panelText.includes("不含任何对话文本"));
ok("页脚说明如何恢复官方界面", panelText.includes("dsh-plugin-catalog"));
ok("后台任务在跑时有横幅", (() => {
	const busyData = { ...data, job: { running: true, kind: "stats", progress: { phase: "scan", done: 120, total: 772 } } };
	T.store.data = busyData;
	const busyPanel = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = data;
	return busyPanel.includes("后台任务") && busyPanel.includes("120/772");
})());

/* ② 搜索 / 筛选 / 排序 */
function visibleNames() {
	const tree = expand(render(T.Panel, {}));
	/* ★ 必须按 className 的**分词**精确匹配：`dpc-card-foot` 也 contains("dpc-card")，
	   用子串匹配会把卡片内部碎片也当成卡片（这个 bug 让三条筛选断言假失败过）。 */
	const cards = findAll(tree, (node) => {
		const className = node.props && typeof node.props.className === "string" ? node.props.className : "";
		const tokens = className.split(/\s+/);
		/* 排除宿主核心卡：它固定单列在筛选结果之外，不该被"筛选"断言算进去 */
		return tokens.includes("dpc-card") && !tokens.includes("dpc-card-host");
	});
	return cards.map((card) => textsOf(card).join(" "));
}

T.store.query = "";
T.store.source = "any";
T.store.kind = "all";
T.store.sort = "calls";
const byCalls = visibleNames();
T.store.sort = "name";
const byName = visibleNames();
ok("排序「调用次数」与「名称」结果不同", JSON.stringify(byCalls) !== JSON.stringify(byName));

T.store.query = "vision";
const searched = visibleNames();
ok("搜索能过滤（只剩 vision）", searched.length >= 1 && searched.every((text) => text.includes("vision")), JSON.stringify(searched).slice(0, 200));
T.store.query = "";
T.store.source = "self";
const selfOnly = visibleNames();
ok("来源筛选「自写」只留自写", selfOnly.length >= 1 && selfOnly.every((text) => text.includes("自写")), JSON.stringify(selfOnly).slice(0, 200));
T.store.source = "any";
T.store.kind = "skill";
const skillOnly = visibleNames();
ok("类型筛选「Skill」只留 Skill", skillOnly.length === 1 && skillOnly[0].includes("vex-ops"), JSON.stringify(skillOnly));
T.store.kind = "all";

/* ②.5 列表分页（2026-10-21 加：之前 127 条一次性铺满，没有翻页也没有页大小） */
T.store.pageSize = 2;
T.store.page = 1;
const pageOne = visibleNames();
ok("分页：每页 2 条时只渲染 2 张卡", pageOne.length === 2, JSON.stringify(pageOne).slice(0, 160));
T.store.page = 2;
const pageTwo = visibleNames();
ok(
	"分页：翻到第 2 页换成了不同的卡",
	pageTwo.length === 2 && JSON.stringify(pageOne) !== JSON.stringify(pageTwo),
	JSON.stringify(pageTwo).slice(0, 160),
);
ok("分页：页码显示为「2 / N」", (() => {
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	return /2\s*\/\s*\d+/.test(text);
})());
T.store.pageSize = 0;
T.store.page = 1;
const allCards = visibleNames();
ok("分页：页大小设 0（全部）时不再截断", allCards.length > 2, "all=" + allCards.length);
ok("分页条显示总条数", (() => {
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	const match = text.match(/共\s*(\d+)\s*条/);
	return Boolean(match) && Number(match[1]) >= allCards.length;
})());
T.store.pageSize = 24;
T.store.page = 1;

/* ③ 浮窗：条目详情 */
const detail = {
	ok: true,
	item: { ...data.entries[0], tags: { purpose: ["screenshot"], context: ["web-gui"], origin: ["src-self"] } },
	tools: [
		{ name: "screenshot", calls: 8000, errors: 2, avgMs: 420, lastUsed: Date.now() - 3600000, sessions: 30 },
		{ name: "shot_probe", calls: 4345, errors: 5, avgMs: 1200, lastUsed: Date.now() - 7200000, sessions: 12 },
	],
	sessions: {
		items: [
			{ id: "session-1", title: "TKS后台10", calls: 300, isSubagent: false, depth: 0, parentTitle: "", lastAt: Date.now() - 3600000 },
			{ id: "session-2", title: "子代理-截图验收", calls: 120, isSubagent: true, depth: 1, parentTitle: "TKS后台10", lastAt: Date.now() - 7200000 },
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
T.store.open = { id: "plugin:dsh-screenshot", page: 1, pageSize: 20 };
T.store.detail = detail;

const modal = expand(render(T.EntryModal, {}));
const modalText = textsOf(modal).join(" | ");
ok("浮窗渲染出来", Boolean(modal));
ok("浮窗有遮罩层（点外部关闭）", findAll(modal, (node) => node.props && node.props.className === "dpc-overlay").length > 0);
ok("浮窗是居中的对话框", findAll(modal, (node) => node.props && String(node.props.className || "").includes("dpc-modal")).length > 0);
ok("浮窗显示总调用", modalText.includes("总调用"));
ok("浮窗显示分工具次数（screenshot / shot_probe）", modalText.includes("screenshot") && modalText.includes("shot_probe"));
ok("浮窗显示报错与平均耗时", modalText.includes("平均耗时") && modalText.includes("420"));
/* 宿主核心那一层要能看出"这个工具其实属于哪个官方包"，所以 owner 列只在有 owner 时出现 */
ok("普通插件不显示空的「归属」列", !textsOf(render(T.ToolTable, { tools: detail.tools })).join("|").includes("归属"));
const hostTools = [
	{ name: "pwsh", calls: 13000, errors: 39, avgMs: 59000, lastUsed: Date.now(), sessions: 330, owner: "@deepseek-ai/dsh-tool-pwsh", how: "description" },
	{ name: "plugin_manager", calls: 22, errors: 0, avgMs: 100, lastUsed: Date.now(), sessions: 5, owner: "", how: "host" },
];
const hostTableText = textsOf(render(T.ToolTable, { tools: hostTools })).join("|");
ok("宿主核心工具显示归属包", hostTableText.includes("归属") && hostTableText.includes("@deepseek-ai/dsh-tool-pwsh"));
ok("没有归属的工具显示占位而不留空", hostTableText.includes("—"));
ok("浮窗会话列表含昵称", modalText.includes("TKS后台10"));
ok("子代理会话被单独标记", modalText.includes("子代理") && modalText.includes("父：TKS后台10"));
ok("会话分页控件在", modalText.includes("第 1 / 3 页") && modalText.includes("上一页") && modalText.includes("下一页"));
ok("每页条数可选", modalText.includes("10") && modalText.includes("100"));
ok("来源判定依据展示出来", modalText.includes("link/junction 安装"));
ok("可以手工改来源（标一次不再问）", modalText.includes("判错了就标一次"));
ok("自写条目有上传/更新按钮", modalText.includes("上传 / 更新到 GitHub"));
ok("自写条目有缺口分析入口", modalText.includes("缺口分析"));
ok("显示仓库链接", modalText.includes("github.com/JHboy203/dsh-screenshot"));
ok("显示创建/下载时间", modalText.includes("创建/下载时间"));
ok("标签区可新增自定义标签", modalText.includes("新增自定义标签"));
/* 新增表单默认是收起的：预置 hooks[0]=true 把「已点开」这个分支渲染出来。
   ⚠️ 不能用 render()（它内部会 resetHooks 把预置值清掉）。 */
resetHooks();
hookStates[0] = true;
const tagEditor = T.TagEditor({ item: data.entries[0], all: data.tags.all });
const tagEditorText = textsOf(tagEditor).join(" | ");
ok("标签区说明解释是必填（AI 分类要靠它）", tagEditorText.includes("解释是必填") && tagEditorText.includes("AI 分类要靠它判断"));
ok("自定义标签表单有名字与解释两个输入", findAll(tagEditor, (node) => node.props && typeof node.props.placeholder === "string").length >= 2);
ok("自定义标签只能进 purpose / context 两个维度", (() => {
	const select = findAll(tagEditor, (node) => node.type === "select")[0];
	const options = findAll(select, (node) => node.type === "option").map((node) => textsOf(node).join(""));
	return options.length === 2 && options.join("|").includes("做什么") && options.join("|").includes("用在哪里");
})());

/* ③b Skill：如实标注统计限制 */
T.store.open = { id: "skill:vex-ops", page: 1, pageSize: 20 };
T.store.detail = {
	ok: true,
	item: { ...data.entries[2] },
	tools: [],
	sessions: { items: [], page: 1, pages: 1, total: 0, pageSize: 20, pageSizes: [10, 20] },
	statsLimited: true,
};
const skillModal = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
ok("Skill 浮窗如实说明机制限制", skillModal.includes("机制限制") && skillModal.includes("无法细分到会话"));
ok("Skill 浮窗不显示工具明细表（无工具可归属）", !skillModal.includes("平均耗时"));

/* ④ 上传计划浮窗 */
T.store.open = null;
T.store.detail = null;
T.store.plan = {
	planId: "plan-abc",
	login: "JHboy203",
	summary: { create: 2, update: 1, upToDate: 20, blocked: 1, needsAttention: 0, readmeNeedingEnglish: 3 },
	items: [
		{ id: "plugin:dsh-screenshot", kind: "plugin", name: "dsh-screenshot", repo: "dsh-screenshot", source: "self", action: "update", reasons: ["本地与远端不一致，将推送"], scan: { files: 120, worst: "clean", hits: [] } },
		{ id: "plugin:dsh-leaky", kind: "plugin", name: "dsh-leaky", repo: "dsh-leaky", source: "self", action: "blocked-secrets", reasons: ["扫描命中 2 条（最高 critical）—— 本仓不推，先处理"], scan: { files: 10, worst: "critical", hits: [{ kind: "content", severity: "critical", file: "lib/config.js", line: 12, rule: "openai-key", sample: "sk-a…****** (len=51)", plain: "像真实配置值，建议改成环境变量并从历史里清掉。" }] } },
	],
	uploadResult: null,
};
const planModal = expand(render(T.PlanModal, {}));
const planText = textsOf(planModal).join(" | ");
ok("计划浮窗列出每个仓", planText.includes("dsh-screenshot") && planText.includes("dsh-leaky"));
ok("计划浮窗把密钥命中摊开（文件:行 + 掩码 + 一句判断）", planText.includes("lib/config.js:12") && planText.includes("******") && planText.includes("建议改成环境变量"));
ok("计划浮窗说明密钥命中的仓会被跳过", planText.includes("跳过"));
ok("计划浮窗显示 gh 用户", planText.includes("JHboy203"));
ok("计划浮窗有确认推送按钮", planText.includes("确认推送"));
ok("计划浮窗声明不 force push", planText.includes("不 force push"));

/* ⑤ 空数据 / 坏数据 */
T.store.plan = null;
T.store.data = { ...data, entries: [], hostCore: { calls: 0, tools: [] }, totals: { plugins: 0, skills: 0, bySource: {}, askUser: 0, calls: 0, errors: 0, subagentCalls: 0 } };
const emptyText = textsOf(expand(render(T.Panel, {}))).join(" | ");
ok("没有条目时给出人话", emptyText.includes("没有匹配的条目"));

T.store.data = null;
T.store.loading = true;
const loadingText = textsOf(expand(render(T.Panel, {}))).join(" | ");
ok("加载中显示提示", loadingText.includes("读取插件目录"));

T.store.loading = false;
T.store.error = "boom";
T.store.data = null;
const errorTree = expand(render(T.Panel, {}));
const errorText = textsOf(errorTree).join(" | ");
ok("读不到时说明原因并可重试", errorText.includes("读不到目录") && errorText.includes("重试"));

/* ⑤b 用户可见文本里不许漏出 markdown 记号
   （`**` 在纯文本里就是两个字面星号 —— 真机截图上看见过「将新建**私有**仓」，很难看）
   ⚠️ 掩码本身是星号（`sk-a…****** (len=51)`），要先按掩码形态剥掉，否则守卫自己会误报。 */
const visibleSamples = { panelText, modalText, skillModal, planText, emptyText, errorText };
const stripMasks = (text) => String(text).replace(/…\*+/g, "").replace(/\*{3,}/g, "").replace(/\(len=\d+\)/g, "");
const leaked = Object.entries(visibleSamples)
	.filter(([, text]) => stripMasks(text).includes("**"))
	.map(([name]) => name);
ok("界面文本里没有漏出的 markdown `**`", leaked.length === 0, "泄漏在: " + leaked.join(", "));

/* ⑥ 侧栏入口 */
resetHooks();
const entry = render(T.SidebarEntry, { size: 18 });
const entryText = textsOf(entry).join(" ");
ok("侧栏入口渲染出图标容器", Boolean(entry));
ok("侧栏入口有 tooltip（含待确认数量）", findAll(entry, (node) => node.props && typeof node.props.title === "string" && node.props.title.includes("插件目录")).length > 0);
/* 点击必须能真的调到 layout.selectPanel（否则"点了没反应"，而且会被 try/catch 吞掉） */
ok("侧栏图标点击会调 layout.selectPanel('catalog')", (() => {
	let selected = null;
	const fakeCtx = { layout: { selectPanel: (id) => { selected = id; } }, effect: (fn) => { fn(); }, slots: { inject: () => {}, register: () => {} } };
	T.apply(fakeCtx);
	const clickable = findAll(T.SidebarEntry({ size: 18 }), (node) => node.props && typeof node.props.onClick === "function")[0];
	if (!clickable) return false;
	clickable.props.onClick();
	return selected === "catalog";
})());

/* ── 汇总 ── */
console.log("");
console.log("dsh-plugin-catalog / render-check");
console.log("  passed: " + passed);
console.log("  failed: " + failed);
if (failed > 0) {
	console.log("");
	for (const failure of failures) console.log("  ✗ " + failure);
	console.log("");
	process.exit(1);
}
console.log("  all good");
