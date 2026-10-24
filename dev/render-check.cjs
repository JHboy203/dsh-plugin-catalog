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
		/* R12：默认按"bundles 里直接启用"；各夹具按需覆盖成 config / transitive / dormant */
		loadState: "bundle",
		loadVia: "",
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
			/* R15：game / astrbot 只有 vex-ops 一条在用 —— 用来验「同维度或、跨维度且」里那个「或」 */
			{ id: "game", dimension: "purpose", label: "游戏", gloss: "Minecraft 相关", builtin: true },
			{ id: "web-gui", dimension: "context", label: "Web GUI", gloss: "作用在界面上", builtin: true },
			{ id: "astrbot", dimension: "context", label: "AstrBot", gloss: "QQ 机器人链路", builtin: true },
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
		makeItem({ id: "plugin:@anionex/dsh-vision-toolkit", name: "@anionex/dsh-vision-toolkit", source: "third", calls: 200, errors: 2, subagentCalls: 0, descriptionZh: "视觉工具包：看图、定位、长截图 OCR。", descriptionEn: "Vision toolkit.", toolNames: ["vision_glance", "vision_ground", "vision_ocr"], dependency: true, dependents: [], dependentCount: 0, dependsOn: [], dependsOnCount: 0, orphanHint: false, /* R12：不在 bundles 但在跑 —— 旧口径会把它置灰并写「启用：否」 */
			enabled: false, loadState: "transitive", loadVia: "dsh-vision-router" }),
		makeItem({ id: "skill:vex-ops", kind: "skill", name: "vex-ops", calls: 19, errors: 0, subagentCalls: 0, sessions: 0, descriptionZh: "维护 Vex：QQ 机器人链路。", descriptionEn: "", lastUsed: Date.now() - 86400000, tags: { purpose: ["game"], context: ["astrbot"], origin: ["src-self"] }, realDir: "D:\\信息库\\AI工作区\\.dsh\\skills\\vex-ops", isLink: false, inAsar: false }),
		/* R9：被 2 个包依赖 —— 删它会让它们坏（卡片上要看得见） */
		makeItem({ id: "plugin:dsh-ofm-ops", name: "dsh-ofm-ops", source: "pending", askUser: true, calls: 3, errors: 1, descriptionZh: "", descriptionEn: "Some plugin.", sourceWhy: ["从 npm 安装", "工作区 DSH-Plugin/ 下有同名目录，可能是本地改过的副本，需你确认"], dependency: false, dependents: ["dsh-diag", "dsh-testbed"], dependentCount: 2, dependsOn: ["@dsh-ops/pwsh-win32-x64"], dependsOnCount: 1, orphanHint: false, /* R12：配置条目挂载（不在 bundles，但会被加载） */
			enabled: false, loadState: "config", loadVia: "ofm-ops" }),
		/* R2：一条从未被调用过的条目 —— 洞察条的「未使用」与「从未调用」全靠它验
		   R9：同时是「无人依赖」的候选（没人声明依赖它、也不在 profile 的 dependencies 里） */
		makeItem({ id: "plugin:dsh-never-used", name: "dsh-never-used", calls: 0, errors: 0, lastUsed: 0, subagentCalls: 0, sessions: 0, descriptionZh: "从没被调用过的插件。", descriptionEn: "Never used.", toolNames: ["unused_tool"], dependency: false, dependents: [], dependentCount: 0, dependsOn: [], dependsOnCount: 0, orphanHint: true, /* R12：没有任何入口引用 —— 装了也不会被加载 */
			loadState: "dormant", loadVia: "" }),
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
ok("视图键固定是那几个（query/source/kind/sort/usage/pageSize/page/orphanOnly/dormantOnly/tagFilter），滚动位置单独存", T.VIEW_KEYS.join(",") === "query,source,kind,sort,usage,pageSize,page,orphanOnly,dormantOnly,tagFilter" && typeof T.VIEW_KEY === "string" && T.VIEW_KEY.includes("dsh-plugin-catalog"));

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
	"有任务在跑时「自检」禁用（单任务闸，不会两个后台任务互抢）",
	(() => {
		const saved = T.store.data;
		T.store.data = { ...data, job: { running: true, kind: "catalog", progress: { done: 1, total: 3 } } };
		const disabled = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-btn") && String((node.props && node.props.title) || "").includes("发版体检")).every((node) => node.props.disabled === true);
		T.store.data = saved;
		return disabled;
	})(),
);

/* ─────────── R11：从「发现问题」到「处置」───────────
   这一轮不加新视图，只让面板处置它自己报出来的两类问题：
   ① Skill 的 staging 旧了 → 就地同步（单向 live → staging）；
   ② 自检红了 → 失败项直接摊在面板上，不用先去 .cache 找报告。 */

ok(
	"isStageStale：只有「内容不同 / 加载的那份更新」算旧（staging 更新绝不能自动同步）",
	T.isStageStale({ staged: true, verdict: "differs" }) &&
		T.isStageStale({ staged: true, verdict: "newer-loaded" }) &&
		!T.isStageStale({ staged: true, verdict: "newer-workspace" }) &&
		!T.isStageStale({ staged: true, verdict: "same" }) &&
		!T.isStageStale({ staged: false, verdict: "differs" }) &&
		!T.isStageStale({ verdict: "differs" }) &&
		!T.isStageStale(null),
);
ok(
	"staleSkillIds 只挑 Skill、且按 drift 判定",
	JSON.stringify(
		T.staleSkillIds({
			"skill:a": { staged: true, verdict: "differs" },
			"skill:b": { staged: true, verdict: "newer-workspace" },
			"skill:c": { staged: true, verdict: "newer-loaded" },
			"plugin:d": { verdict: "differs" },
			"skill:e": { staged: true, verdict: "same" },
		}),
	) === JSON.stringify(["skill:a", "skill:c"]) && JSON.stringify(T.staleSkillIds(null)) === "[]",
);

/* 公告条：Skill 的 staging 旧了 → 就地给一个「同步 staging」入口 */
const staleData = {
	...data,
	drift: {
		"skill:vex-ops": { staged: true, verdict: "differs", differs: ["SKILL.md"], workspaceDir: "D:\\w\\.gh-upload\\my-dsh-skills\\vex-ops", loadedDir: "D:\\w\\.dsh\\skills\\vex-ops" },
		"skill:dsh-plugin-catalog": { staged: true, verdict: "newer-loaded", differs: [], workspaceDir: "D:\\w\\.gh-upload\\my-dsh-skills\\dsh-plugin-catalog", loadedDir: "D:\\w\\.dsh\\skills\\dsh-plugin-catalog" },
	},
};
T.store.data = staleData;
T.store.open = null;
T.store.syncPlan = null;
T.store.syncBusy = false;
const staleText = textsOf(expand(render(T.Panel, {}))).join(" | ");
const syncButtons = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-btn") && textsOf(node).join("").includes("同步 staging"));
ok("staging 旧了时公告条上出现「同步 staging（2）」", staleText.includes("2 个 Skill 的 staging 是旧的") && staleText.includes("同步 staging（2）") && syncButtons.length === 1, staleText.slice(0, 300));
ok("同步按钮说明方向与备份（title 里写清单向 + .bak）", syncButtons.length === 1 && String(syncButtons[0].props.title).includes("单向") && String(syncButtons[0].props.title).includes(".bak-"));
ok(
	"没有可同步的 Skill 时不出现同步按钮（staging 更新不算）",
	(() => {
		const saved = T.store.data;
		T.store.data = { ...data, drift: { "skill:vex-ops": { staged: true, verdict: "newer-workspace", workspaceDir: "D:\\w\\s", loadedDir: "D:\\w\\l" } } };
		const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
		T.store.data = saved;
		return !text.includes("同步 staging（");
	})(),
);

/* 二次确认条：写盘前必须看见会覆盖哪些文件 */
const syncPlanFixture = {
	ok: true,
	count: 2,
	direction: "live → staging",
	items: [
		{ id: "skill:vex-ops", name: "vex-ops", verdict: "differs", loadedDir: "D:\\w\\.dsh\\skills\\vex-ops", stagedDir: "D:\\w\\.gh-upload\\my-dsh-skills\\vex-ops", differs: ["SKILL.md"] },
		{ id: "skill:dsh-plugin-catalog", name: "dsh-plugin-catalog", verdict: "newer-loaded", loadedDir: "D:\\w\\.dsh\\skills\\dsh-plugin-catalog", stagedDir: "D:\\w\\.gh-upload\\my-dsh-skills\\dsh-plugin-catalog", differs: [] },
	],
	skipped: [],
};
T.store.syncPlan = syncPlanFixture;
const confirmTree = expand(render(T.Panel, {}));
const confirmText = textsOf(confirmTree).join(" | ");
ok("出过计划后面板出现确认条，并写明覆盖几个文件", confirmText.includes("将把 2 个 Skill 的 SKILL.md 复制到 staging") && confirmText.includes("live → staging"));
ok("确认条列出将覆盖的 Skill 名（可核对，不是「你确认一下」）", confirmText.includes("vex-ops") && confirmText.includes("dsh-plugin-catalog"));
ok("确认条写明备份落在哪、不动加载的那份", confirmText.includes("SKILL.md.bak-<时间戳>") && confirmText.includes("不会动 DSH 正在加载的那份"));
const confirmButtons = findAll(confirmTree, (node) => String((node.props && node.props.className) || "").includes("dpc-btn") && textsOf(node).join("").includes("确认同步"));
ok("确认条两个动作：确认同步（带条数）/ 取消", confirmButtons.length === 1 && textsOf(confirmButtons[0]).join("").includes("确认同步（2 个）") && confirmText.includes("取消"));

/* 浮窗里的单条同步：只有 staging 旧了才给按钮，linked / 一致不给 */
T.store.data = staleData;
T.store.open = { id: "skill:vex-ops", page: 1, pageSize: 20 };
T.store.syncPlan = null;
T.store.detail = { ok: true, item: (staleData.entries || []).find((entry) => entry.id === "skill:vex-ops"), tools: [], sessions: { items: [], page: 1, pageSize: 20, total: 0, pages: 1, pageSizes: [10, 20] }, descendants: 0, statsMeta: {}, statsLimited: true, readme: null };
const skillModalText = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
ok("Skill 浮窗给出「同步这一份 → staging」", skillModalText.includes("同步这一份 → staging") && skillModalText.includes("单向 live → staging"));
ok("还没有历史备份时说明清楚（第一次同步才会生成 .bak）", skillModalText.includes("staging 里还没有历史备份") && !skillModalText.includes("历史备份 1 份"));

/* R20：浮窗里的「历史备份」与「还原到 <stamp>」入口（staging 与 live 一致时也必须在） */
T.store.data = {
	...data,
	drift: {
		"skill:vex-ops": {
			staged: true,
			verdict: "same",
			workspaceDir: "D:\\w\\.gh-upload\\my-dsh-skills\\vex-ops",
			loadedDir: "D:\\w\\.dsh\\skills\\vex-ops",
			backups: { count: 3, latest: { name: "SKILL.md.bak-20261024-120000", stamp: "20261024-120000", size: 2048, mtimeMs: 1 } },
		},
	},
};
T.store.open = { id: "skill:vex-ops", page: 1, pageSize: 20 };
T.store.syncPlan = null;
T.store.restorePlan = null;
T.store.detail = { ok: true, item: (T.store.data.entries || []).find((entry) => entry.id === "skill:vex-ops"), tools: [], sessions: { items: [], page: 1, pageSize: 20, total: 0, pages: 1, pageSizes: [10, 20] }, descendants: 0, statsMeta: {}, statsLimited: true, readme: null };
const backupModalText = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
ok(
	"浮窗显示「历史备份 N 份 · 最近 <stamp>」与「还原到 <stamp>」（两份一致时也能撤销）",
	backupModalText.includes("历史备份 3 份") && backupModalText.includes("20261024-120000") && backupModalText.includes("还原到 20261024-120000"),
	backupModalText.slice(0, 260),
);
const restorePlanFixture = {
	ok: true,
	count: 1,
	direction: "backup → staging",
	items: [{ id: "skill:vex-ops", name: "vex-ops", stagedDir: "D:\\w\\.gh-upload\\my-dsh-skills\\vex-ops", backup: "SKILL.md.bak-20261024-120000", backupStamp: "20261024-120000", backupBytes: 2048, currentBytes: 2100, verdict: "same" }],
	skipped: [],
};
T.store.restorePlan = restorePlanFixture;
const restoreText = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
ok(
	"还原确认条：方向 / 只动 staging / 覆盖前另存 / 两个动作齐全",
	restoreText.includes("覆盖成备份版本") && restoreText.includes("backup → staging") && restoreText.includes("不动 DSH 正在加载的 SKILL.md") && restoreText.includes("确认还原（1 个）") && restoreText.includes("取消"),
	restoreText.slice(0, 260),
);
T.store.restorePlan = null;
T.store.data = staleData;
T.store.open = { id: "skill:vex-ops", page: 1, pageSize: 20 };
T.store.detail = { ok: true, item: (staleData.entries || []).find((entry) => entry.id === "skill:vex-ops"), tools: [], sessions: { items: [], page: 1, pageSize: 20, total: 0, pages: 1, pageSizes: [10, 20] }, descendants: 0, statsMeta: {}, statsLimited: true, readme: null };
ok(
	"副本一致 / junction 时不给同步按钮（别让人以为有东西要同步）",
	(() => {
		const saved = T.store.data;
		const savedOpen = T.store.open;
		T.store.data = { ...data, drift: { "skill:vex-ops": { staged: true, verdict: "same", workspaceDir: "D:\\w\\s", loadedDir: "D:\\w\\l" } } };
		T.store.open = { id: "skill:vex-ops", page: 1, pageSize: 20 };
		T.store.detail = { ...T.store.detail, item: (T.store.data.entries || []).find((entry) => entry.id === "skill:vex-ops") };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.data = saved;
		T.store.open = savedOpen;
		return !text.includes("同步这一份");
	})(),
);
ok(
	"同步进行中时确认条按钮禁用（不会连点两次写两遍）",
	(() => {
		const saved = { syncPlan: T.store.syncPlan, open: T.store.open, syncBusy: T.store.syncBusy };
		T.store.syncPlan = syncPlanFixture;
		T.store.open = null;
		T.store.syncBusy = true;
		const tree = expand(render(T.Panel, {}));
		const labels = findAll(tree, (node) => String((node.props && node.props.className) || "").includes("dpc-btn") && (textsOf(node).join("").includes("同步中") || textsOf(node).join("").includes("确认同步"))).map((node) => ({ text: textsOf(node).join(""), disabled: Boolean(node.props.disabled) }));
		T.store.syncPlan = saved.syncPlan;
		T.store.open = saved.open;
		T.store.syncBusy = saved.syncBusy;
		return labels.length === 1 && labels[0].disabled === true && labels[0].text.includes("同步中");
	})(),
);
T.store.open = null;
T.store.detail = null;

/* 体检结论卡：失败项要能在面板上直接读到 */
const preflightOk = {
	ok: true,
	durationMs: 45000,
	at: Date.now(),
	reportPath: "D:\\信息库\\AI工作区\\DSH-Plugin\\dsh-plugin-catalog\\.cache\\ship-1.md",
	version: { ok: true, version: "0.11.0", build: "r11.0" },
	git: { ok: true, headShort: "abc1234", dirty: 0, pushed: true },
	totals: { passed: 585, failed: 0, skipped: 0 },
	checks: [
		{ id: "audit", label: "自洽契约", ok: true, passed: 300, failed: 0, skipped: 0, durationMs: 20000 },
		{ id: "render", label: "界面渲染", ok: true, passed: 140, failed: 0, skipped: 0, durationMs: 8000 },
		{ id: "hosttest", label: "宿主行为", ok: true, passed: 145, failed: 0, skipped: 1, durationMs: 16000 },
		{ id: "staging", label: "副本同步", ok: true, informational: true, pairs: 17, stale: ["a", "b", "c"], durationMs: 20 },
	],
};
const preflightBad = {
	...preflightOk,
	ok: false,
	checks: [
		{ id: "audit", label: "自洽契约", ok: false, passed: 298, failed: 2, skipped: 0, durationMs: 20000, failures: ["有 2 个审计契约", "syncPlan 没进 __test"] },
		{ id: "render", label: "界面渲染", ok: true, passed: 140, failed: 0, skipped: 0, durationMs: 8000 },
		{ id: "hosttest", label: "宿主行为", ok: true, passed: 145, failed: 0, skipped: 1, durationMs: 16000 },
		{ id: "staging", label: "副本同步", ok: true, informational: true, pairs: 17, stale: ["a"], durationMs: 20 },
	],
};
ok("体检卡：全绿时四个检查项都列出、副本同步说「17 对 / 3 旧」", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, preflight: preflightOk, job: { running: false, kind: "stats", progress: { done: 1, total: 1 } } };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return text.includes("上次自检：全绿") && text.includes("自洽契约") && text.includes("界面渲染") && text.includes("宿主行为") && text.includes("17 对 / 3 旧") && text.includes("版本 0.11.0 ↔ r11.0");
})());
ok("体检卡：失败时把失败项直接摊开（带检查名与原文）", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, preflight: preflightBad, job: { running: false, kind: "stats", progress: { done: 1, total: 1 } } };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return text.includes("1 项失败") && text.includes("有 2 个审计契约") && text.includes("syncPlan 没进 __test") && text.includes("298 通过 · 2 失败");
})());
ok("体检卡有「复制报告路径」「重跑」两个动作", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, preflight: preflightBad, job: { running: false, kind: "stats", progress: { done: 1, total: 1 } } };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return text.includes("复制报告路径") && text.includes("重跑");
})());
ok("体检卡：结论来自服务端单独存的 preflight，不被后来的后台任务顶掉（真机 bug 回归）", (() => {
	const saved = T.store.data;
	/* job 这一格此刻是 stats（统计自愈），体检结论仍要在 */
	T.store.data = { ...data, preflight: preflightOk, job: { running: false, kind: "stats", finishedAt: Date.now(), result: { ok: true }, progress: { done: 1, total: 1 } } };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return text.includes("上次自检：全绿");
})());
ok("没有体检记录时不画结论卡（普通后台任务不冒充）", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, preflight: null, job: { running: false, kind: "stats", finishedAt: Date.now(), result: { ok: true }, progress: { done: 1, total: 1 } } };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return !text.includes("上次自检：");
})());

T.store.data = data;
T.store.syncPlan = null;
T.store.syncBusy = false;

/* ─── R14：处置清单卡（只生成、不执行） ───
   这里验的是"面板有没有把处置方式说清楚 + 有没有偷偷提供一个删除按钮"：
   分类 chip、可回收体积、"要先摘 profile 依赖"、两次点击才写入。 */
const uninstallFixture = {
	at: Date.now(),
	elapsedMs: 420,
	dormant: { dirCandidates: 26, packages: 26, groups: 2, reclaimBytes: Math.round(8.3 * 1024 * 1024), linkBytes: Math.round(358 * 1024), nestedOnly: ["lodash"], duplicateCopies: ["string-width"] },
	groups: [
		{ key: "group-1:dsh-mnemon", name: "dsh-mnemon", label: "dsh-mnemon 等 20 个", count: 20, reclaimBytes: Math.round(5.2 * 1024 * 1024), linkBytes: 0, pinnedCount: 1, duplicate: false, linkCount: 0, kinds: ["pinned", "entity"], members: [{ dirName: "dsh-mnemon", pkg: "dsh-mnemon", link: false }, { dirName: "dsh-mnemon-provider-mem0", pkg: "dsh-mnemon-provider-mem0", link: false }] },
		{ key: "group-2:ghbackup", name: "ghbackup", label: "dsh-github-backup", count: 1, reclaimBytes: 0, linkBytes: Math.round(123.3 * 1024), pinnedCount: 0, duplicate: true, linkCount: 1, kinds: ["duplicate"], members: [{ dirName: "ghbackup", pkg: "dsh-github-backup", link: true }] },
	],
	savedTo: "",
};
let uninstallText = "";
ok("处置清单卡：标题写明「只生成、不执行」，并给出候选目录数 / 组数 / 可回收体积", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, uninstall: uninstallFixture, job: { running: false, kind: "", progress: { done: 0, total: 0 } } };
	T.store.uninstallConfirm = false;
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	uninstallText = text;
	return text.includes("处置清单（只生成、不执行）") && text.includes("候选目录 26 个 / 2 组") && text.includes("可回收 8.3 MB") && text.includes("358 KB 在链接目标里");
})(), "命中处置清单=" + uninstallText.includes("处置清单") + " 卡=" + uninstallText.includes("处置清单（只生成、不执行）") + " 候选=" + uninstallText.includes("候选目录 26 个 / 2 组") + " 可回收=" + uninstallText.includes("可回收 8.3 MB") + " 链接=" + uninstallText.includes("358 KB 在链接目标里"));
ok("处置清单卡：分组行带分类 chip（被钉住 / 同项目第二份）与「要先摘 profile 依赖」", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, uninstall: uninstallFixture };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return text.includes("dsh-mnemon 等 20 个") && text.includes("被钉住") && text.includes("要先摘 profile 依赖") && text.includes("同项目第二份") && text.includes("1 个链接（删了省 0 B）");
})());
let cardButtonTexts = [];
ok("处置清单卡：卡里**没有任何删除按钮**（写入是唯一写动作，且要两次点击）", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, uninstall: uninstallFixture };
	T.store.uninstallConfirm = false;
	/* ★ 只看**卡里的**按钮：面板别处的按钮 title 里本来就会说到"删掉不影响加载" */
	const buttonsIn = (tree) => {
		const card = findAll(tree, (node) => String((node.props && node.props.className) || "").includes("dpc-uninstall"))[0];
		if (!card) return [];
		return findAll(card, (node) => String((node.props && node.props.className) || "").includes("dpc-btn")).map((node) => textsOf(node).join(" "));
	};
	const firstPass = buttonsIn(expand(render(T.Panel, {})));
	cardButtonTexts = firstPass;
	T.store.uninstallConfirm = true;
	const secondPass = buttonsIn(expand(render(T.Panel, {})));
	T.store.data = saved;
	T.store.uninstallConfirm = false;
	const noDelete = firstPass.every((text) => !/删除|卸载执行|立即清/.test(text));
	return firstPass.some((text) => text.includes("写入 reports/")) && noDelete && secondPass.some((text) => text.includes("确认写入（不会删任何目录）"));
})(), "卡内按钮：" + JSON.stringify(cardButtonTexts));
ok("没有清单时不画卡（只有点过「处置清单」才占版面）", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, uninstall: null };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return !text.includes("处置清单（只生成、不执行）");
})());

/* ── R16：删除预演（只算不删） ── */
const simSafe = {
	ok: true,
	verdict: "safe",
	remove: ["dsh-mnemon", "lib-d"],
	unknown: [],
	before: { counts: { bundle: 7, config: 0, transitive: 153, dormant: 26 }, total: 186 },
	after: { counts: { bundle: 7, config: 0, transitive: 153, dormant: 24 }, total: 184 },
	breaking: [],
	brokenEntries: [],
	dangling: [],
	demoted: [{ name: "lib-x", state: "transitive" }],
	revived: [],
	bytes: { reclaimBytes: 8700000, whyZero: [{ dirName: "ghbackup", provenance: "duplicate" }], unlisted: [] },
};
let simSafeText = "";
ok("预演结果块：安全态写清「摘掉几个 / 可回收多少 / 三行风险都为无」", (() => {
	const saved = T.store.data;
	const savedSim = T.store.sim;
	T.store.data = { ...data, uninstall: uninstallFixture };
	T.store.sim = simSafe;
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	simSafeText = text;
	T.store.data = saved;
	T.store.sim = savedSim;
	return (
		text.includes("删除预演（只算不删）") &&
		text.includes("安全") &&
		text.includes("摘掉 2 个包") &&
		text.includes("可回收 8.3 MB") &&
		text.includes("现在会被加载（本来就不该删）：无") &&
		text.includes("删完会指空的入口：无") &&
		text.includes("仍声明它们的包：无") &&
		text.includes("删完会掉回「不加载」：lib-x") &&
		text.includes("加载态 bundle 7 / config 0 / 随依赖 153 / 不加载 26 → bundle 7 / config 0 / 随依赖 153 / 不加载 24") &&
		text.includes("删了省 0 B 的：ghbackup")
	);
})(), simSafeText.includes("dpc-sim") ? simSafeText.slice(simSafeText.indexOf("dpc-sim"), simSafeText.indexOf("dpc-sim") + 700) : "NO_SIM_BLOCK");
ok("预演结果块：有风险时三类问题都点名（入口指空 / 仍被声明 / 本身会被加载）", (() => {
	const saved = T.store.data;
	const savedSim = T.store.sim;
	T.store.data = { ...data, uninstall: uninstallFixture };
	T.store.sim = {
		...simSafe,
		verdict: "risky",
		breaking: [{ name: "lib-z", state: "transitive", via: "dsh-ops" }],
		brokenEntries: [{ name: "dsh-mnemon", why: "bundle", id: "" }],
		dangling: [{ from: "dsh-ops", dep: "lib-z" }],
	};
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	T.store.sim = savedSim;
	return (
		text.includes("有风险") &&
		text.includes("lib-z（transitive）") &&
		text.includes("dsh-mnemon（bundle）") &&
		text.includes("dsh-ops → lib-z")
	);
})());
ok("预演结果块：没预演过就不出现（刷新后不许拿旧「安全」背书一次删除）", (() => {
	const saved = T.store.data;
	const savedSim = T.store.sim;
	T.store.data = { ...data, uninstall: uninstallFixture };
	T.store.sim = null;
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	T.store.sim = savedSim;
	return !text.includes("删除预演（只算不删）") && text.includes("处置清单（只生成、不执行）");
})());
/* ── R17：变化条（自上次快照以来变了什么） ── */
const changesFixture = {
	at: 1761300000000,
	baselineAt: 1761200000000,
	first: false,
	total: 133,
	unchanged: 130,
	counts: { added: 1, removed: 0, version: 2, source: 0, loadState: 0, edited: 0, total: 3 },
	added: [{ id: "plugin:new", name: "new-pkg", kind: "plugin", version: "1.0.0" }],
	removed: [],
	versionChanged: [
		{ id: "plugin:a", name: "alpha", kind: "plugin", from: "1.0.0", to: "1.1.0" },
		{ id: "plugin:b", name: "beta", kind: "plugin", from: "2.0.0", to: "2.1.0" },
	],
	sourceChanged: [],
	loadStateChanged: [],
	edited: [],
};
ok("变化条：有变化时出现，写明「N 处变化」与分类 chip（默认收起，不画明细）", (() => {
	const saved = T.store.data;
	const savedOpen = T.store.showChanges;
	T.store.data = { ...data, changes: changesFixture };
	T.store.showChanges = false;
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	T.store.showChanges = savedOpen;
	return text.includes("3 处变化") && text.includes("新增 1") && text.includes("升版 2") && !text.includes("alpha 1.0.0 → 1.1.0");
})());
ok("变化条：点开才列明细（升版写成 from → to）", (() => {
	const saved = T.store.data;
	const savedOpen = T.store.showChanges;
	T.store.data = { ...data, changes: changesFixture };
	T.store.showChanges = true;
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	T.store.showChanges = savedOpen;
	return text.includes("alpha 1.0.0 → 1.1.0") && text.includes("beta 2.0.0 → 2.1.0") && text.includes("+ new-pkg 1.0.0");
})());
ok("变化条：第一条快照 / 0 处变化都不占版面（「还没有历史」不等于「没变化」）", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, changes: { ...changesFixture, first: true, counts: { ...changesFixture.counts, total: 0 } } };
	const firstText = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = { ...data, changes: { ...changesFixture, counts: { ...changesFixture.counts, total: 0 } } };
	const zeroText = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return !firstText.includes("处变化") && !zeroText.includes("处变化");
})());

/* ── R19：确认窗口（标记「已看过」之后只看那之后的变化）+ 正文改动措辞 ── */
const sinceAckFixture = {
	at: 1761400000000,
	baselineAt: 1761350000000,
	first: false,
	total: 133,
	unchanged: 132,
	acked: true,
	ackAt: 1761350000000,
	ackEntries: 133,
	counts: { added: 0, removed: 0, version: 1, source: 0, loadState: 0, edited: 0, total: 1 },
	added: [],
	removed: [],
	versionChanged: [{ id: "plugin:a", name: "alpha", kind: "plugin", from: "1.0.0", to: "1.1.0" }],
	sourceChanged: [],
	loadStateChanged: [],
	edited: [],
};
ok("变化条 R19：标记过「已看过」后显示确认窗口（不再冒充「自上次快照」），并带标记按钮", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, changes: changesFixture, sinceAck: sinceAckFixture };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return text.includes("确认以来") && text.includes("1 处变化") && text.includes("标记已看过") && !text.includes("3 处变化");
})());
ok("变化条 R19：确认窗口为 0 处时不占版面（窗口真的清零，而不是继续显示旧变化）", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, changes: changesFixture, sinceAck: { ...sinceAckFixture, counts: { ...sinceAckFixture.counts, total: 0 }, versionChanged: [] } };
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return !text.includes("处变化");
})());
ok("变化条 R19：正文改动写成「正文已改」并带短哈希", (() => {
	const saved = T.store.data;
	const savedOpen = T.store.showChanges;
	T.store.showChanges = true;
	T.store.data = {
		...data,
		changes: { ...changesFixture, counts: { ...changesFixture.counts, added: 0, version: 0, edited: 1, total: 1 }, added: [], versionChanged: [], edited: [{ id: "skill:gamma", name: "gamma", kind: "skill", reason: "content", from: "aaaa1111", to: "bbbb3333" }] },
	};
	const text = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	T.store.showChanges = savedOpen;
	return text.includes("gamma 正文已改（aaaa1111 → bbbb3333）");
})());
ok("运行中版本与磁盘不一致时，头部标「（未重载）」；一致时不出现", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, build: { label: "0.18.0 · 2026-10-24 13:20", version: "0.18.0", loaded: "0.17.0", stale: true } };
	const staleText = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = { ...data, build: { label: "0.18.0 · 2026-10-24 13:20", version: "0.18.0", loaded: "0.18.0", stale: false } };
	const freshText = textsOf(expand(render(T.Panel, {}))).join(" | ");
	T.store.data = saved;
	return staleText.includes("（未重载）") && staleText.includes("运行中 0.17.0") && !freshText.includes("（未重载）");
})());
ok("工具条有「处置清单」按钮，title 写明只生成不执行、写入要再确认", (() => {
	const tree = expand(render(T.Panel, {}));
	const buttons = findAll(tree, (node) => String((node.props && node.props.className) || "").includes("dpc-btn"));
	const target = buttons.find((node) => textsOf(node).join("").includes("处置清单"));
	if (!target) return false;
	return String(target.props.title).includes("只生成、永不执行删除") && String(target.props.title).includes("需要再点一次确认");
})(), (() => {
	const tree = expand(render(T.Panel, {}));
	const buttons = findAll(tree, (node) => String((node.props && node.props.className) || "").includes("dpc-btn"));
	const hit = buttons.find((node) => textsOf(node).join("").includes("处置清单"));
	return "按钮数=" + buttons.length + " 找到=" + Boolean(hit) + " title=" + (hit ? String(hit.props.title).slice(0, 40) : "");
})());

T.store.data = data;

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
const leakedDetail = Object.entries(visibleSamples)
	.filter(([, text]) => stripMasks(text).includes("**"))
	.map(([name, text]) => {
		const at = stripMasks(text).indexOf("**");
		return name + "：「" + String(text).slice(Math.max(0, at - 24), at + 24) + "」";
	});
ok("界面文本里没有漏出的 markdown `**`", leakedDetail.length === 0, "泄漏在: " + leakedDetail.join(", "));

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

/* ⑦ R12：装了到底会不会跑 —— 四态在界面上的表现 */
T.store.error = null;
T.store.data = data;
T.store.loading = false;
T.store.open = null;
T.store.detail = null;
T.store.size = null;
T.store.sizeError = "";
T.store.pageSize = 0;
T.store.page = 1;
T.store.query = "";
T.store.source = "any";
T.store.kind = "all";
T.store.usage = "any";
T.store.orphanOnly = false;
T.store.dormantOnly = false;

ok("isDormant 只认 loadState === 'dormant'（`enabled === false` 不算）", T.isDormant({ loadState: "dormant" }) === true && T.isDormant({ enabled: false }) === false && T.isDormant({ enabled: false, loadState: "transitive" }) === false);
ok("isConfigLoaded 只认 config（transitive 与 dormant 都不算）", T.isConfigLoaded({ loadState: "config" }) === true && T.isConfigLoaded({ loadState: "transitive" }) === false && T.isConfigLoaded({ loadState: "dormant" }) === false);
ok(
	"loadLabel 只给两档（不会被加载 / 配置入口），bundle 与 transitive 不占版面",
	T.loadLabel({ loadState: "dormant" }) === "不会被加载" &&
		T.loadLabel({ loadState: "config" }) === "配置入口" &&
		T.loadLabel({ loadState: "bundle" }) === "" &&
		T.loadLabel({ loadState: "transitive" }) === "" &&
		T.loadLabel({ enabled: false }) === "",
);
ok(
	"loadCell 四态各一句话（否 / 配置(id) / 随 X / 是），未知时如实说未知",
	T.loadCell({ loadState: "dormant" }) === "否" &&
		T.loadCell({ loadState: "config", loadVia: "ofm-ops" }) === "配置(ofm-ops)" &&
		T.loadCell({ loadState: "transitive", loadVia: "dsh-vision-router" }) === "随 dsh-vision-router" &&
		T.loadCell({ loadState: "bundle" }) === "是" &&
		T.loadCell({}) === "未知" &&
		T.loadCell({ kind: "skill" }) === "",
);
ok("dormantCountOf 只数 dormant", T.dormantCountOf(data.entries) === 1 && T.dormantCountOf([]) === 0);

const loadChips = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").split(/\s+/).includes("dpc-load"));
/* ★ textsOf 会连 props 里的字符串（title 说明书）一起收，所以 chip 文案只看 children */
const chipTexts = loadChips.map((node) => textsOf(node.props.children).join(""));
ok("「不会被加载」条目有灰 chip，「配置入口」条目有蓝 chip，transitive/bundle 没有 chip", chipTexts.includes("不会被加载") && chipTexts.includes("配置入口") && chipTexts.length === 2, "实际: " + JSON.stringify(chipTexts));
ok(
	"chip 的悬停说明写清「不在 bundles / 不在配置 / 不在依赖链」",
	(() => {
		const dormantChip = loadChips.find((node) => textsOf(node.props.children).join("") === "不会被加载");
		const title = String((dormantChip && dormantChip.props.title) || "");
		return title.includes("dsh.profile.bundles") && title.includes("cordis 配置条目") && title.includes("依赖链") && title.includes("宿主不会加载它");
	})(),
);
ok(
	"置灰只跟 dormant 走：`enabled: false` 但 transitive 的卡片不置灰（旧口径会把它变暗）",
	(() => {
		const cards = findAll(expand(render(T.Panel, {})), (node) => {
			const className = String((node.props && node.props.className) || "");
			return className.split(/\s+/).includes("dpc-card");
		});
		const byName = (name) => cards.find((node) => textsOf(node.props.children).join(" ").includes(name));
		const dormantCard = byName("dsh-never-used");
		const transitiveCard = byName("@anionex/dsh-vision-toolkit");
		return Boolean(dormantCard && transitiveCard) && dormantCard.props.className.split(/\s+/).includes("is-off") && !transitiveCard.props.className.split(/\s+/).includes("is-off");
	})(),
);

ok(
	"工具条上就有「不会被加载 N」（不用先去记住哪个包没入口）",
	textsOf(expand(render(T.Panel, {}))).join(" | ").includes("不会被加载 1"),
);
ok(
	"点它只留 dormant 条目（1 条），别的全被筛掉",
	(() => {
		const saved = T.store.dormantOnly;
		T.store.dormantOnly = true;
		const names = visibleNames();
		T.store.dormantOnly = saved;
		/* visibleNames 返回的是每张卡的整段文本，不是裸名字 */
		return names.length === 1 && names[0].includes("dsh-never-used");
	})(),
);

ok(
	"浮窗「加载路径」把 dormant 说成 ❌ 并解释为什么可以删、以及什么时候别删",
	(() => {
		const saved = { open: T.store.open, detail: T.store.detail };
		T.store.open = { id: "plugin:dsh-never-used", page: 1, pageSize: 20 };
		T.store.detail = { ok: true, item: { ...data.entries[4] }, tools: [], sessions: { items: [], page: 1, pages: 1, total: 0, pageSize: 20, pageSizes: [10, 20] }, statsLimited: false };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.open = saved.open;
		T.store.detail = saved.detail;
		return text.includes("加载路径：❌") && text.includes("删掉不影响当前加载") && text.includes("cordis.patch.yml");
	})(),
);
ok(
	"浮窗对 transitive 写出具体链路（随 dsh-vision-router 加载）与「删了会连带弄坏」",
	(() => {
		const saved = { open: T.store.open, detail: T.store.detail };
		T.store.open = { id: "plugin:@anionex/dsh-vision-toolkit", page: 1, pageSize: 20 };
		T.store.detail = { ok: true, item: { ...data.entries[1] }, tools: [], sessions: { items: [], page: 1, pages: 1, total: 0, pageSize: 20, pageSizes: [10, 20] }, statsLimited: false };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.open = saved.open;
		T.store.detail = saved.detail;
		return text.includes("随 dsh-vision-router 加载") && text.includes("删了会连带弄坏") && text.includes("配置(ofm-ops)") === false;
	})(),
);
ok(
	"浮窗对 config 写出配置条目 id（不在 bundles 也会加载）",
	(() => {
		const saved = { open: T.store.open, detail: T.store.detail };
		T.store.open = { id: "plugin:dsh-ofm-ops", page: 1, pageSize: 20 };
		T.store.detail = { ok: true, item: { ...data.entries[3] }, tools: [], sessions: { items: [], page: 1, pages: 1, total: 0, pageSize: 20, pageSizes: [10, 20] }, statsLimited: false };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.open = saved.open;
		T.store.detail = saved.detail;
		return text.includes("配置条目 `ofm-ops` 挂着（不在 bundles）—— 会加载。") && text.includes("配置(ofm-ops)");
	})(),
);
ok(
	"宿主没给 loadState 时如实说来源未知，不拿 enabled 猜",
	(() => {
		const saved = { open: T.store.open, detail: T.store.detail };
		T.store.open = { id: "plugin:dsh-screenshot", page: 1, pageSize: 20 };
		T.store.detail = { ok: true, item: { ...data.entries[0], loadState: "", enabled: false }, tools: [], sessions: { items: [], page: 1, pages: 1, total: 0, pageSize: 20, pageSizes: [10, 20] }, statsLimited: false };
		const text = textsOf(expand(render(T.EntryModal, {}))).join(" | ");
		T.store.open = saved.open;
		T.store.detail = saved.detail;
		return text.includes("宿主还没给出加载态") && text.includes("启用") && text.includes("未知");
	})(),
);

/* ─────────── R15：标签闭环（批量打标 + 按标签筛选）───────────
   这一轮最容易"看着对、其实没用"的两处：
     ① 筛选行画出来了但点不动，或点了不减少卡片；
     ② 批量浮层画成二态开关 —— 用户以为点一下是"设成这个"，实际是"给缺的补上"。
   所以这里不只看元素在不在，还要**真的点一下**再数卡片。 */

function resetView() {
	T.store.error = null;
	T.store.data = data;
	T.store.loading = false;
	T.store.open = null;
	T.store.detail = null;
	T.store.size = null;
	T.store.sizeError = "";
	T.store.pageSize = 0;
	T.store.page = 1;
	T.store.query = "";
	T.store.source = "any";
	T.store.kind = "all";
	T.store.usage = "any";
	T.store.orphanOnly = false;
	T.store.dormantOnly = false;
	T.store.tagFilter = [];
	T.store.tagPick = null;
	T.store.picking = false;
	T.store.picked = [];
}

function cards() {
	/* 精确匹配 dpc-card 且带 title（Card 是按钮、一定有 title；网格容器没有）：
	   startsWith 会把 dpc-card-head / dpc-card-body 一起数进来（21 vs 6 条） */
	return findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").split(" ").includes("dpc-card") && typeof (node.props && node.props.title) === "string");
}

resetView();
const facetChips = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-facet-chip"));
ok("标签筛选行只列「有条目在用」的标签（夹具里 6 个标签，其中 c-1 没人用，不该出现）", facetChips.length > 0 && !facetChips.some((node) => textsOf(node).join("").includes("视频剪辑")), JSON.stringify(facetChips.map((node) => textsOf(node).join(""))));
ok(
	"每个筛选 chip 带命中条数（点之前就知道点了会剩几条）",
	facetChips.every((node) => /[0-9]/.test(textsOf(node).join(""))),
	JSON.stringify(facetChips.map((node) => textsOf(node).join(""))),
);

const facetTexts = facetChips.map((node) => textsOf(node).join(""));
const shotChip = facetChips.find((node) => textsOf(node).join("").includes("截图"));
const countWith = (dimension, tagId) => data.entries.filter((item) => (item.tags?.[dimension] || []).includes(tagId)).length;
ok(`「截图」chip 的计数与夹具一致（${countWith("purpose", "screenshot")} 条带 screenshot）`, Boolean(shotChip) && textsOf(shotChip).join("").includes(String(countWith("purpose", "screenshot"))), JSON.stringify(facetTexts));

const beforeTagClick = cards().length;
if (shotChip && typeof shotChip.props.onClick === "function") shotChip.props.onClick();
ok(
	"点一下标签 chip 真的把卡片筛掉了（不是只变了个样式）",
	T.store.tagFilter.includes("screenshot") && cards().length === countWith("purpose", "screenshot") && cards().length < beforeTagClick,
	`before=${beforeTagClick} after=${cards().length} expect=${countWith("purpose", "screenshot")}`,
);
ok("筛完还会再渲染出「清除标签」按钮", findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-btn") && textsOf(node).join("").includes("清除标签")).length === 1);

/* 跨维度是 AND：再叠一个 context，必须两个维度都命中 */
T.store.tagFilter = ["screenshot", "web-gui"];
ok("跨维度是「且」（screenshot + web-gui 两个都命中）", cards().length === 5, JSON.stringify(T.store.tagFilter));
T.store.tagFilter = ["screenshot", "astrbot"];
ok("跨维度是「且」（没有人既 screenshot 又 astrbot → 0 条，而不是取并集）", cards().length === 0, JSON.stringify(T.store.tagFilter));

/* 同一维度是 OR */
T.store.tagFilter = ["screenshot", "game"];
ok("同维度是「或」（screenshot 或 game，比单筛截图多出 vex-ops）", cards().length === 6 && cards().length > countWith("purpose", "screenshot"), `${cards().length} 条`);

resetView();
ok("没有标签被用着时整行不占位（不显示空框）", (() => {
	const saved = T.store.data;
	T.store.data = { ...data, entries: data.entries.map((item) => ({ ...item, tags: { purpose: [], context: [], origin: item.tags.origin } })) };
	const row = findAll(expand(render(T.Panel, {})), (node) => String((node.props && node.props.className) || "").includes("dpc-tagfilter"));
	T.store.data = saved;
	return row.length === 0;
})());

/* 批量浮层的三态 */
resetView();
T.store.tagPick = { ids: ["plugin:dsh-screenshot", "plugin:dsh-never-used"] };
const batchChips = findAll(expand(render(T.TagBatchModal, { ids: T.store.tagPick.ids })), (node) => String((node.props && node.props.className) || "").split(" ").includes("dpc-tag"));
const batchTexts = batchChips.map((node) => textsOf(node).join(""));
ok("批量浮层把「这批全都有的标签」画成已选（截图 2/2）", batchChips.some((node) => String(node.props.className).includes("is-all") && textsOf(node).join("").includes("截图")), JSON.stringify(batchTexts));
ok("批量浮层把「部分有的标签」画成半选（虚线，2/2 之外的标签为 0/2 空态）", batchChips.every((node) => textsOf(node).join("").includes("/2")), JSON.stringify(batchTexts));
ok("每个标签都带「这批里几个有」的比值（n/N），不让人盲点", batchTexts.filter((text) => text.includes("/2")).length === batchChips.length);

/* 三态不能靠"点一下再看"验（每次 render 都是新实例、useState 不跨渲染保留），
   所以验的是**点之前就能看见的承诺**：title 里写清这次点击会加上还是去掉。 */
const allChip = batchChips.find((node) => String(node.props.className).split(" ").includes("is-all"));
const emptyChips = batchChips.filter((node) => !String(node.props.className).includes("is-all"));
ok("全都有的标签：点之前就写明「点一下＝全部去掉」", Boolean(allChip) && String(allChip.props.title).includes("点一下＝全部去掉"), allChip ? String(allChip.props.title) : "无");
ok("一条都没有的标签：点之前就写明「点一下＝给缺的补上」", emptyChips.length > 0 && emptyChips.every((node) => String(node.props.title).includes("点一下＝给缺的补上")), JSON.stringify(emptyChips.map((node) => String(node.props.title))));
ok("「应用」按钮在没有改动时是禁用的（不会发一个空请求）", (() => {
	const buttons = findAll(expand(render(T.TagBatchModal, { ids: T.store.tagPick.ids })), (node) => String((node.props && node.props.className) || "").includes("dpc-btn") && textsOf(node).join("").includes("没改动"));
	return buttons.length === 1 && buttons[0].props.disabled === true;
})(), "应用按钮");

T.store.tagPick = null;
resetView();

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
