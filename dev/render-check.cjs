/**
 * dev/render-check.cjs — 界面层自检（**不需要 DSH、不需要浏览器**）。
 *
 * 做法：给 client.js 一个极小的 React 替身（只实现 useState/useEffect/useMemo/useRef），
 * 把 __test 里的组件真的渲染一遍，然后对输出的虚拟树断言：
 *   · 卡片上有没有名字/中文简介/英文原文/来源徽章/调用次数/时间
 *   · 搜索与各种排序是否真的改变结果顺序
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
		errors: 9,
		toolNames: ["screenshot", "shot_probe", "shot_longshot"],
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
		/* R9：依赖字段 —— 直接写在 profile、但没有任何包依赖它（不是候选，因为它是显式装的） */
		makeItem({ dependency: true, dependents: [], dependentCount: 0, dependsOn: ["@deepseek-ai/cordis"], dependsOnCount: 1, orphanHint: false }),
		makeItem({ id: "plugin:@anionex/dsh-vision-toolkit", name: "@anionex/dsh-vision-toolkit", source: "third", calls: 200, errors: 2, subagentCalls: 0, descriptionZh: "视觉工具包：看图、定位、长截图 OCR。", descriptionEn: "Vision toolkit.", toolNames: ["vision_glance", "vision_ground", "vision_ocr"], dependency: true, dependents: [], dependentCount: 0, dependsOn: [], dependsOnCount: 0, orphanHint: false }),
		makeItem({ id: "skill:vex-ops", kind: "skill", name: "vex-ops", calls: 19, errors: 0, subagentCalls: 0, sessions: 0, descriptionZh: "维护 Vex：QQ 机器人链路。", descriptionEn: "", lastUsed: Date.now() - 86400000, tags: { purpose: ["game"], context: ["astrbot"], origin: ["src-self"] }, realDir: "D:\\信息库\\AI工作区\\.dsh\\skills\\vex-ops", isLink: false, inAsar: false }),
		/* R9：被 2 个包依赖 —— 删它会让它们坏（卡片上要看得见） */
		makeItem({ id: "plugin:dsh-ofm-ops", name: "dsh-ofm-ops", source: "pending", askUser: true, calls: 3, errors: 1, descriptionZh: "", descriptionEn: "Some plugin.", sourceWhy: ["从 npm 安装", "工作区 DSH-Plugin/ 下有同名目录，可能是本地改过的副本，需你确认"], dependency: false, dependents: ["dsh-diag", "dsh-testbed"], dependentCount: 2, dependsOn: ["@dsh-ops/pwsh-win32-x64"], dependsOnCount: 1, orphanHint: false }),
		/* R2：一条从未被调用过的条目 —— 洞察条的「未使用」与「从未调用」全靠它验
		   R9：同时是「无人依赖」的候选（没人声明依赖它、也不在 profile 的 dependencies 里） */
		makeItem({ id: "plugin:dsh-never-used", name: "dsh-never-used", calls: 0, errors: 0, lastUsed: 0, subagentCalls: 0, sessions: 0, descriptionZh: "从没被调用过的插件。", descriptionEn: "Never used.", toolNames: ["unused_tool"], dependency: false, dependents: [], dependentCount: 0, dependsOn: [], dependsOnCount: 0, orphanHint: true }),
		/* R3：一条只被子代理调过的条目 —— 删它不会当场报错，只会让某条委派链悄悄变差 */
		makeItem({ id: "plugin:dsh-delegate-only", name: "dsh-delegate-only", calls: 5, errors: 0, subagentCalls: 5, sessions: 0, descriptionZh: "只被子代理用过的插件。", descriptionEn: "Delegate only.", dependency: false, dependents: [], dependentCount: 0, dependsOn: [], dependsOnCount: 0, orphanHint: false }),
	],
	hostCore: { id: "host-core", kind: "host", name: "宿主核心工具", calls: 38000, tools: [{ name: "pwsh", calls: 13000 }, { name: "read", calls: 8000 }, { name: "edit", calls: 7000 }] },
	totals: { plugins: 70, skills: 55, calls: 13000, errors: 7, subagentCalls: 500, hostCoreCalls: 38000, bySource: { official: 7, self: 22, third: 40, hybrid: 1, pending: 1 }, askUser: 1 },
	publishing: { skillsRepo: "my-dsh-skills", skillsStageDir: "x" },
	/* R8：体积快照 —— 卡片体积 / 按体积排序 / 筛选合计都读它。
	   dsh-delegate-only 故意**不在**快照里：它是"量不到"的那一类（官方 asar 内或没有独立目录），
	   合计里要被排除、并点出条数，而不是当成 0 字节。 */
	sizes: {
		at: Date.now() - 5 * 60 * 1000,
		count: 5,
		totalBytes: 10137524 + 6000575 + 4096 + 34567 + 2012345,
		byId: {
			"plugin:dsh-screenshot": 10137524,
			"plugin:@anionex/dsh-vision-toolkit": 6000575,
			"skill:vex-ops": 4096,
			"plugin:dsh-ofm-ops": 34567,
			"plugin:dsh-never-used": 2012345,
		},
	},
	drift: {},
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
ok("有七种排序选项（R2 报错次数 / R3 报错率 / R8 体积）", T.SORTS.length === 7 && T.SORTS.map((s) => s.id).join(",") === "calls,errors,rate,size,recent,time,name");
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

/* R8：体积成了一等公民 —— 卡片上有体积、能按体积排序、筛选合计说得清 */
T.store.sort = "size";
const bySize = visibleNames();
ok(
	"排序「体积」按字节降序（9.7 MB 的排第一，量不到的排最后）",
	bySize[0].includes("dsh-screenshot") && bySize[bySize.length - 1].includes("delegate-only"),
	JSON.stringify(bySize.map((text) => text.slice(0, 40))).slice(0, 300),
);
ok(
	"卡片上有体积 chip（.dpc-size 里是 9.7 MB）",
	(() => {
		const chips = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").split(/\s+/).includes("dpc-size"));
		/* ★ textsOf 会连 props 里的字符串一起收（title 里写着字节数），所以只能 contains，不能全等 */
		const labels = chips.map((chip) => textsOf(chip).join(" "));
		return chips.length === 5 && labels.some((label) => label.includes("9.7 MB")) && labels.some((label) => label.includes("4 KB"));
	})(),
);
ok(
	"量不到的条目（不在快照里）不显示体积，也不写「0 B」",
	(() => {
		const cards = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").split(/\s+/).includes("dpc-card") && textsOf(node).join(" ").includes("delegate-only"));
		return cards.length === 1 && !textsOf(cards[0]).join(" ").includes("0 B");
	})(),
);
ok(
	"工具条显示当前筛选的体积合计（点「未使用」就能看到能省多少）",
	(() => {
		const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
		/* 6 条里 5 条有体积：10137524+6000575+4096+34567+2012345 = 18189107 B → 17.3 MB，另外 1 条量不到 */
		return text.includes("合计 17.3 MB") && text.includes("1 条无可量目录");
	})(),
);
ok(
	"没有体积快照时不显示合计（也不编一个 0 MB 出来）",
	(() => {
		const saved = T.store.data;
		T.store.data = { ...data, sizes: null };
		const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
		T.store.data = saved;
		return !text.includes("合计 ") && !text.includes("无可量目录");
	})(),
);
ok(
	"sizeOfItem：量不到返回 null（绝不返回 0），量到返回字节数",
	T.sizeOfItem({ id: "a" }, { a: 12 }) === 12 && T.sizeOfItem({ id: "b" }, { a: 12 }) === null && T.sizeOfItem({ id: "c" }, { c: null }) === null && T.sizeOfItem(null, {}) === null,
);

/* R9：依赖归属 —— 「删了会弄坏谁」「那个大二进制是谁带进来的」 */
ok(
	"depLabel：被依赖 → 「被 N 依赖」；无人依赖 → 「无人依赖」；Skill 与普通直接依赖不显示",
	T.depLabel({ dependents: ["a", "b"], dependentCount: 2 }) === "被 2 依赖" &&
		T.depLabel({ dependents: [], dependentCount: 0, orphanHint: true }) === "无人依赖" &&
		T.depLabel({ kind: "skill", dependents: [], dependentCount: 0, orphanHint: true }) === "" &&
		T.depLabel({ dependents: [], dependentCount: 0, dependency: true }) === "" &&
		T.depLabel(null) === "",
);
ok("isOrphanHint 只认服务端给的候选标记", T.isOrphanHint({ orphanHint: true }) === true && T.isOrphanHint({}) === false && T.isOrphanHint(null) === false);
ok(
	"卡片上有依赖 chip：「被 2 依赖」与「无人依赖」各一枚",
	(() => {
		const chips = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").split(/\s+/).includes("dpc-dep"));
		const labels = chips.map((chip) => textsOf(chip).join(" "));
		return chips.length === 2 && labels.some((label) => label.includes("被 2 依赖")) && labels.some((label) => label.includes("无人依赖"));
	})(),
);
ok(
	"无人依赖的 chip 带「需确认」口径（候选不是结论）",
	(() => {
		const chip = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").split(/\s+/).includes("dpc-dep") && textsOf(node).join(" ").includes("无人依赖"))[0];
		const title = String((chip && chip.props && chip.props.title) || "");
		return title.includes("候选") && title.includes("npm ls");
	})(),
);
ok(
	"工具条有「无人依赖 N」筛选按钮，点开只剩候选",
	(() => {
		const before = textsOf(expand(render(T.Panel, {}))).join(" | ");
		if (!/无人依赖 1(?![0-9])/.test(before)) return false;
		const saved = { orphanOnly: T.store.orphanOnly, kind: T.store.kind, source: T.store.source };
		T.store.orphanOnly = true;
		const names = visibleNames();
		T.store.orphanOnly = saved.orphanOnly;
		return names.length === 1 && names[0].includes("dsh-never-used");
	})(),
);
T.store.sort = "calls";
T.store.kind = "all";
T.store.source = "any";
T.store.orphanOnly = false;

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

/* ②.6 R2（2026-10-22）：洞察条 / 工具名搜索 / 报错排序 / 快捷键 */
T.store.pageSize = 0;
T.store.page = 1;
T.store.query = "";
T.store.source = "any";
T.store.kind = "all";
T.store.usage = "any";
T.store.sort = "calls";

const allText = textsOf(expand(render(T.Panel, {}))).join(" | ");
ok("洞察条五个 chip 都在（全部 / 有调用 / 未使用 / 有报错 / 仅子代理）", ["全部", "有调用", "未使用", "有报错", "仅子代理"].every((label) => allText.includes(label)));
ok(
	"每个 chip 都有说明书（「仅子代理 0」必须能解释成「这台机器上没有这种人」，而不是坏了）",
	T.USAGE_HINTS && T.USAGE_HINTS.subonly.includes("委派链") && ["any", "used", "unused", "errors", "subonly"].every((id) => typeof T.USAGE_HINTS[id] === "string" && T.USAGE_HINTS[id].length > 6),
);
ok("洞察条给出「未使用」的条数（夹具里 1 条从未调用）", /未使用\s*1(?![0-9])/.test(allText), allText.slice(0, 240));
ok(
	"洞察条把「有报错」标成告警色",
	findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("is-warn")).length > 0,
);

T.store.usage = "unused";
const unusedCards = visibleNames();
ok("点「未使用」只剩从未调用的条目", unusedCards.length === 1 && unusedCards[0].includes("dsh-never-used"), JSON.stringify(unusedCards).slice(0, 200));
T.store.usage = "errors";
const errorCards = visibleNames();
ok("点「有报错」只剩有报错的条目", errorCards.length === 3 && errorCards.every((text) => text.includes("报错")), JSON.stringify(errorCards).slice(0, 240));
ok(
	"洞察条的数字不随筛选跳（点开「有报错」后「未使用」仍是 1）",
	/未使用\s*1(?![0-9])/.test(textsOf(expand(render(T.Panel, {}))).join(" | ")),
);
T.store.usage = "any";

/* R3：只被子代理调过 —— 删掉不会当场报错，清理前必须单独看见 */
T.store.usage = "subonly";
const subOnlyCards = visibleNames();
ok("点「仅子代理」只剩「每一次调用都发生在子代理里」的条目", subOnlyCards.length === 1 && subOnlyCards[0].includes("dsh-delegate-only"), JSON.stringify(subOnlyCards).slice(0, 240));
ok(
	"isSubagentOnly 不把「从没调用」和「自己也用过」混进来",
	!T.isSubagentOnly({ calls: 0, subagentCalls: 0 }) && !T.isSubagentOnly({ calls: 9, subagentCalls: 4 }) && T.isSubagentOnly({ calls: 4, subagentCalls: 4 }) && !T.isSubagentOnly(null),
);
T.store.usage = "any";

T.store.query = "vision_ground";
const toolSearched = visibleNames();
ok("搜索能命中工具名（vision_ground → vision-toolkit）", toolSearched.length === 1 && toolSearched[0].includes("@anionex/dsh-vision-toolkit"), JSON.stringify(toolSearched).slice(0, 240));
ok("卡片把命中的工具名显示出来", toolSearched.length === 1 && toolSearched[0].includes("工具：vision_ground"), JSON.stringify(toolSearched).slice(0, 240));
T.store.query = "";

T.store.sort = "errors";
const errSorted = visibleNames();ok(
	"排序「报错次数」把报错多的排前面（9 / 2 / 1）",
	errSorted.length >= 3 && errSorted[0].includes("dsh-screenshot") && errSorted[1].includes("dsh-vision-toolkit") && errSorted[2].includes("dsh-ofm-ops"),
	JSON.stringify(errSorted.map((text) => text.slice(0, 24))).slice(0, 240),
);

/* R3：报错率 —— 1/3 远比 9/12345 严重，按次数排会把前者埋掉 */
T.store.sort = "rate";
const rateSorted = visibleNames();
ok(
	"排序「报错率」把 1/3 排在 9/12345 前面（次数排序看不出这个差别）",
	rateSorted[0].includes("dsh-ofm-ops") && rateSorted[1].includes("dsh-vision-toolkit") && rateSorted[2].includes("dsh-screenshot"),
	JSON.stringify(rateSorted.map((text) => text.slice(0, 24))).slice(0, 240),
);
ok("errorRate 对没调用过的条目返回 0（不假装 100%）", T.errorRate({ calls: 0, errors: 0 }) === 0 && T.errorRate({ calls: 0, errors: 3 }) === 0);

/* R3：视图持久化 —— 无头自检里没有 localStorage，必须安静地放弃而不是抛错 */
ok("没有 localStorage 时读视图返回 null、写视图返回 false（不抛错）", T.readView() === null && T.writeView() === false);
ok("视图键固定是那几个（query/source/kind/sort/usage/pageSize/page/orphanOnly），滚动位置单独存", T.VIEW_KEYS.join(",") === "query,source,kind,sort,usage,pageSize,page,orphanOnly" && typeof T.VIEW_KEY === "string" && T.VIEW_KEY.includes("dsh-plugin-catalog"));

/* R4：导出当前筛选 / 0 值档位置灰 */
T.store.kind = "all";
T.store.usage = "any";
T.store.pageSize = 0;
T.store.page = 1;
const exportButtons = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-export"));
const exportTexts = exportButtons.map((node) => textsOf(node).join(""));
ok("工具条有「导出这 N 条」，N 就是当前筛选条数", exportButtons.length === 1 && exportTexts[0].includes("导出这 6 条"), JSON.stringify(exportTexts));
T.store.kind = "skill";
const zeroChips = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-insight") && String(node.props.className).includes("is-empty")).map((node) => textsOf(node).join(""));
ok("计数为 0 的档位置灰但不隐藏（点开是空态 + 说明书）", zeroChips.length >= 1 && zeroChips.some((text) => text.includes("有报错 0")), JSON.stringify(zeroChips));
T.store.usage = "subonly";
const emptyExport = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-export")).map((node) => ({ text: textsOf(node).join(""), disabled: Boolean(node.props.disabled) }));
ok("筛选结果为 0 时导出按钮禁用（不让用户导出一个空文件）", emptyExport.length === 1 && emptyExport[0].disabled === true && emptyExport[0].text.includes("导出这 0 条"), JSON.stringify(emptyExport));
T.store.usage = "any";
T.store.kind = "all";

/* R10：头部「自检」按钮（一条命令的发版体检） */
/* 注意：textsOf 会把 title 属性也算进文本（R9 踩过），所以这里按 title 认按钮、再验文案 */
const preflightButtons = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-btn") && String((node.props && node.props.title) || "").includes("发版体检"));
ok(
	"头部有「自检」按钮，并说明它跑的是三层自检 + 版本一致性",
	preflightButtons.length === 1 && textsOf(preflightButtons[0]).join("").includes("自检") && String(preflightButtons[0].props.title).includes("版本号与构建戳"),
	JSON.stringify(preflightButtons.map((node) => ({ title: node.props && node.props.title, disabled: node.props && node.props.disabled }))),
);
ok(
	"有任务在跑时「自检」禁用（单任务闸，不会两个后台任务互踩）",
	(() => {
		const saved = T.store.data;
		T.store.data = { ...data, job: { running: true, kind: "catalog", progress: { done: 1, total: 3 } } };
		const disabled = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-btn") && String((node.props && node.props.title) || "").includes("发版体检")).every((node) => node.props.disabled === true);
		T.store.data = saved;
		return disabled;
	})(),
);

/* R5：多选（选中一批 → 看总体积 → 导出这批） */
T.store.pageSize = 0;
T.store.picking = true;
T.store.picked = ["plugin:dsh-screenshot"];
T.store.pickedBytes = 12.3 * 1024 * 1024;
const pickTree = expand(render(T.Panel, {}));
const pickText = textsOf(pickTree).join(" | ");
const pickedCards = findAll(pickTree, (node) => {
	const tokens = String((node.props && node.props.className) || "").split(/\s+/);
	return tokens.includes("dpc-card") && tokens.includes("is-picked");
});
ok("选择模式下被选中的卡片有 is-picked 与勾徽章", pickedCards.length === 1 && textsOf(pickedCards[0]).join(" ").includes("dsh-screenshot") && textsOf(pickedCards[0]).join(" ").includes("✓"), JSON.stringify(pickedCards.length));
ok("批次条显示「已选 1 条 · 约 12.3 MB」", pickText.includes("已选 1 条") && pickText.includes("约 12.3 MB"));
ok(
	"体积里没有独立目录的条数如实点出（不假装它们是 0 字节的插件）",
	(() => {
		const saved = { sizes: T.store.pickedSizes, picked: T.store.picked };
		T.store.picked = ["plugin:dsh-screenshot", "skill:vex-ops"];
		T.store.pickedSizes = { "plugin:dsh-screenshot": 1000, "skill:vex-ops": null };
		const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
		T.store.pickedSizes = saved.sizes;
		T.store.picked = saved.picked;
		return text.includes("1 条没有独立目录");
	})(),
);
ok("批次条有三个动作（导出选中 / 选中当前 / 清空）", pickText.includes("导出选中") && pickText.includes("选中当前 6 条") && pickText.includes("清空"));
ok("工具条「选择」在选择模式下变成「退出选择」", pickText.includes("退出选择"));
ok(
	"togglePick 可重复取消（再点一次回到未选中）",
	(() => {
		const before = T.store.picked.slice();
		T.togglePick("plugin:dsh-screenshot");
		const removed = T.store.picked.length === 0;
		T.togglePick("plugin:dsh-screenshot");
		const restored = T.store.picked.length === 1;
		T.store.picked = before;
		return removed && restored;
	})(),
);
ok(
	"退出选择模式会清空选中（不留幽灵批次）",
	(() => {
		const saved = { picking: T.store.picking, picked: T.store.picked };
		T.store.picking = true;
		T.store.picked = ["plugin:dsh-screenshot"];
		T.togglePicking(); /* → 退出 */
		const cleared = T.store.picking === false && T.store.picked.length === 0;
		T.store.picking = saved.picking;
		T.store.picked = saved.picked;
		return cleared;
	})(),
);
ok("选中项不进 localStorage（视图键里没有 picked）", !T.VIEW_KEYS.includes("picked") && !T.VIEW_KEYS.includes("picking"));
T.store.picking = false;
T.store.picked = [];
T.store.pickedBytes = null;

/* R6：副本漂移（工作区源码 vs 加载的 profile 副本） */
ok(
	"driftLabel 只给三种人看的标签（linked / same / no-copy 都不标）",
	T.driftLabel({ verdict: "differs" }) === "副本不同步" &&
		T.driftLabel({ verdict: "newer-workspace" }) === "副本较旧" &&
		T.driftLabel({ verdict: "newer-loaded" }) === "工作区较旧" &&
		T.driftLabel({ verdict: "linked" }) === "" &&
		T.driftLabel({ verdict: "same" }) === "" &&
		T.driftLabel(null) === "",
);
ok(
	"Skill 的副本叫 staging（那是发布上去的那份）",
	T.driftLabel({ verdict: "differs", staged: true }) === "staging 不同步" && T.driftLabel({ verdict: "newer-loaded", staged: true }) === "staging 较旧" && T.driftLabel({ verdict: "newer-workspace", staged: true }) === "staging 较新",
);
ok(
	"driftDetail 点出两个目录与「改哪份才生效」",
	(() => {
		const text = T.driftDetail({ verdict: "newer-workspace", differs: ["client.js"], workspaceDir: "D:\\w\\dsh-x", loadedDir: "D:\\p\\dsh-x" });
		return text.includes("工作区：D:\\w\\dsh-x") && text.includes("加载的：D:\\p\\dsh-x") && text.includes("改它才会生效") && text.includes("client.js");
	})(),
);
const baseData = T.store.data;
T.store.data = { ...baseData, drift: { "plugin:dsh-screenshot": { verdict: "differs", differs: ["client.js"], workspaceDir: "D:\\w\\DSH-Plugin\\dsh-screenshot", loadedDir: "D:\\p\\node_modules\\dsh-screenshot" } } };
const driftTree = expand(render(T.Panel, {}));
const driftText = textsOf(driftTree).join(" | ");
ok("不同步的卡片有琥珀色「副本不同步」chip", findAll(driftTree, (node) => String((node.props && node.props.className) || "").includes("dpc-drift")).length >= 1 && driftText.includes("副本不同步"));
ok("顶部公告点出不同步的条目名", driftText.includes("个条目的两份副本不同步") && driftText.includes("dsh-screenshot"));
T.store.open = { id: "plugin:dsh-screenshot", page: 1, pageSize: 20 };
/* 这里还不能用后面那个完整夹具（`detail` 在下方才定义），用最小可渲染的详情即可 ——
   要验的是「浮窗里有没有源码同步这句话」，不是详情字段。 */
T.store.detail = {
	ok: true,
	item: T.store.data.entries.find((entry) => entry.id === "plugin:dsh-screenshot"),
	tools: [],
	sessions: { items: [], page: 1, pageSize: 20, total: 0, pages: 1, pageSizes: [10, 20] },
	descendants: 0,
	statsMeta: {},
	statsLimited: false,
	readme: null,
};
const modalDrift = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
ok("浮窗写清「副本同步」结论", modalDrift.includes("副本同步") && modalDrift.includes("源码同步") && modalDrift.includes("副本不同步"));
/* Skill 走同一条路：staging 是发布上去的那份 */
T.store.open = { id: "skill:vex-ops", page: 1, pageSize: 20 };
T.store.data = { ...baseData, drift: { "skill:vex-ops": { verdict: "differs", staged: true, differs: ["SKILL.md"], workspaceDir: "D:\\w\\.gh-upload\\my-dsh-skills\\vex-ops", loadedDir: "D:\\w\\.dsh\\skills\\vex-ops" } } };
T.store.detail = {
	ok: true,
	item: T.store.data.entries.find((entry) => entry.id === "skill:vex-ops"),
	tools: [],
	sessions: { items: [], page: 1, pageSize: 20, total: 0, pages: 1, pageSizes: [10, 20] },
	descendants: 0,
	statsMeta: {},
	statsLimited: true,
	readme: null,
};
const skillDriftText = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
ok("Skill 浮窗写的是「staging 同步」并给出同步建议", skillDriftText.includes("staging 同步") && skillDriftText.includes("发布前先同步这两份"), skillDriftText.slice(0, 200));
T.store.data = baseData;
T.store.open = null;
T.store.detail = null;
T.store.sort = "calls";

ok(
	"isUnused / hasErrors / errorRate 口径一致",
	T.isUnused({ calls: 0 }) && !T.isUnused({ calls: 1 }) && T.hasErrors({ errors: 1 }) && !T.hasErrors({ errors: 0 }) && Math.round(T.errorRate({ calls: 4, errors: 1 }) * 100) === 25,
);
ok("toolHits 少于两个字符不搜（否则一个字母点亮全站）", T.toolHits({ toolNames: ["pwsh"] }, "p").length === 0 && T.toolHits({ toolNames: ["pwsh"] }, "pw").length === 1);
ok(
	"报错 chip 只对有报错的条目出现",
	(() => {
		const cards = visibleNames();
		const never = cards.find((text) => text.includes("dsh-never-used")) || "";
		return never !== "" && !never.includes("报错") && cards[0].includes("报错 9");
	})(),
);
ok(
	"快捷键 /：非输入框里聚焦搜索、输入框里不抢",
	T.hotkeyOf({ key: "/", target: { tagName: "DIV" } }) === "focus-search" && T.hotkeyOf({ key: "/", target: { tagName: "INPUT" } }) === "",
);
ok("快捷键 Esc：清空搜索", T.hotkeyOf({ key: "Escape", target: { tagName: "BODY" } }) === "clear-search");
ok("AUTO_REFRESH_MS 落在 5~60 分钟（太短会退化成一直刷新）", T.AUTO_REFRESH_MS >= 300000 && T.AUTO_REFRESH_MS <= 3600000);

/* ③ 浮窗：条目详情 */
const detail = {
	ok: true,
	item: {
		...data.entries[0],
		realDir: "D:\\信息库\\AI工作区\\DSH-Plugin\\dsh-screenshot",
		isLink: true,
		dependency: true,
		tags: { purpose: ["screenshot"], context: ["web-gui"], origin: ["src-self"] },
	},
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
ok("浮窗显示位置与安装形态（R2）", modalText.includes("位置与安装形态") && modalText.includes("源目录") && modalText.includes("junction / symlink"));
ok("浮窗给出源目录与复制按钮（R2）", modalText.includes("D:\\信息库\\AI工作区\\DSH-Plugin\\dsh-screenshot") && modalText.includes("复制"));
ok("浮窗说清依赖来源（写进 dependencies 的不会被清理）", modalText.includes("不会被依赖树整理顺手清掉"));

/* R4：体积（懒算）—— 三态都要有话说：量好了 / 正在量 / 量不了 */
ok("fmtBytes 口径（B / KB / MB / GB）", T.fmtBytes(512) === "512 B" && T.fmtBytes(2048) === "2 KB" && T.fmtBytes(12.3 * 1024 * 1024) === "12.3 MB" && T.fmtBytes(3 * 1024 * 1024 * 1024) === "3.0 GB");
ok(
	"量好体积时浮窗显示「12.3 MB · 318 个文件」",
	(() => {
		const saved = T.store.size;
		T.store.size = { bytes: 12.3 * 1024 * 1024, files: 318, truncated: false };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.size = saved;
		return text.includes("体积") && text.includes("12.3 MB · 318 个文件");
	})(),
);
ok(
	"体积超预算时如实标注「只算到这里」",
	(() => {
		const saved = T.store.size;
		T.store.size = { bytes: 4096, files: 20000, truncated: true };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.size = saved;
		return text.includes("只算到这里");
	})(),
);
ok(
	"没有独立目录时显示原因而不是 0 B（Skill / asar）",
	(() => {
		const saved = { size: T.store.size, error: T.store.sizeError };
		T.store.size = null;
		T.store.sizeError = "Skill 没有独立目录";
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.size = saved.size;
		T.store.sizeError = saved.error;
		return text.includes("Skill 没有独立目录") && !text.includes("0 B");
	})(),
);
ok(
	"浮窗对「传递依赖」给出会消失的警告",
	(() => {
		const saved = T.store.detail;
		T.store.detail = { ...detail, item: { ...detail.item, dependency: false } };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.detail = saved;
		return text.includes("整理依赖树时可能消失");
	})(),
);
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
/* R8：Skill 也有自己的目录（catalog 的 dir）—— 位置与体积不再只有插件才看得到 */
ok("Skill 浮窗也有「位置与体积」块（不再只有插件才有）", skillModal.includes("位置与体积") && skillModal.includes("技能目录"));
ok("Skill 浮窗给出技能目录路径与复制按钮", skillModal.includes(".dsh\\skills\\vex-ops") && skillModal.includes("复制"));
ok("Skill 浮窗的体积来自全量快照（4 KB），不是「0 B」", skillModal.includes("4 KB（全量快照）") && !skillModal.includes("0 B"));

/* R9：浮窗的「依赖关系」块 —— 插件才有（Skill 之间没有 npm 依赖） */
ok("插件的浮窗有「依赖关系」块（直接声明 / 被谁依赖 / 它依赖谁）", modalText.includes("依赖关系") && modalText.includes("直接声明"));
ok("直接写在 profile 的依赖会说明（要删得同时改 package.json）", modalText.includes("写在 profile 的 package.json dependencies 里"));
ok("它依赖谁也要写出来（体积 Top 的运行时二进制就是这么来的）", modalText.includes("它自己声明依赖 1 个包") && modalText.includes("@deepseek-ai/cordis"));
ok("Skill 浮窗不显示「依赖关系」（Skill 不在 npm 依赖图里）", !skillModal.includes("依赖关系"));
ok(
	"被 N 依赖的条目在浮窗里点名依赖者，并说明「删它会让这些包直接坏掉」",
	(() => {
		const saved = T.store.detail;
		T.store.detail = { ...detail, item: data.entries[3] };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.detail = saved;
		return text.includes("被 2 个包依赖") && text.includes("dsh-diag") && text.includes("删它会让这些包直接坏掉");
	})(),
);

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
