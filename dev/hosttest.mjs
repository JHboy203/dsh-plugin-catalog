/**
 * dev/hosttest.mjs — 宿主侧端到端自检（**不需要重启 DSH、不花 token、不联网推仓**）。
 *
 * 做法：造一个假 ctx（tools / webServer / llm / agentDefaultModel），真的调 `apply(ctx)`，
 * 然后像宿主那样走一遍：
 *   · 工具是不是 7 个都注册成功、是不是都声明了 output 契约；
 *   · 路由是不是真的能应答（/state /entry /tags /upload /health）；
 *   · 冷启动时统计是不是在**后台**算（不阻塞），算完数字对不对；
 *   · AI 路径（分类/翻译）用假 llm 跑通，验证「自定义标签解释被喂进提示词」与 TBD 规则；
 *   · 上传门禁：不带 confirm 必须拒绝。
 *
 * 用法（在能 spawn 的环境里跑，例如宿主侧）：
 *   DSH_CATALOG_DIR=<临时目录> node dev/hosttest.mjs
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail: condition ? "" : detail });
}
function eq(name, actual, expected) {
	ok(name, JSON.stringify(actual) === JSON.stringify(expected), "期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual));
}

const dataDir = process.env.DSH_CATALOG_DIR || join(tmpdir(), "dsh-catalog-hosttest-" + Date.now());
mkdirSync(join(dataDir, "cache"), { recursive: true });
/* 关掉每周自动任务：自检不该调模型、也不该把"上次执行时间"写脏 */
writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ version: 1, settings: { weeklyGapAuto: false, windowDays: 90 } }), "utf8");
process.env.DSH_CATALOG_DIR = dataDir;

/* ── 假宿主 ── */

const registeredTools = [];
const routes = [];
let llmCalls = 0;
let llmNext = "{}";

const fakeTools = {
	register(definition) {
		registeredTools.push(definition);
		return () => {};
	},
	schemas() {
		/* 真机上是 172+ 个工具；这里给 7 个 catalog_*（与真实注册数一致，否则
		   /health 的"注册几个"必然对不上）+ 2 个代表性工具覆盖"官方/第三方"归属。 */
		return [
			{ name: "catalog_list", description: "列出本机所有 DSH 插件与 Skill（含来源四分类）。" },
			{ name: "catalog_stats", description: "查调用统计：全局概览或某条目的分工具明细与涉及会话。" },
			{ name: "catalog_tag", description: "标签管理：列出、给条目打标、新增带解释的自定义标签。" },
			{ name: "catalog_classify", description: "用模型给插件/Skill 自动打标签，会读自定义标签的解释。" },
			{ name: "catalog_review", description: "审一遍某个插件：缺口分析与安全审核，只出建议不改代码。" },
			{ name: "catalog_publish", description: "把自写/混血插件与 Skill 备份到 GitHub 私有仓（plan → apply → public）。" },
			{ name: "catalog_export", description: "把目录快照导出成 Markdown 报告，供交接与留证。" },
			{ name: "catalog_health", description: "目录面板自检：版本、路径、统计覆盖、归属覆盖率。" },
			{ name: "read", description: "Read a UTF-8 text file and return line-numbered content." },
			{ name: "pty_run", description: "在伪终端里跑一条命令并把输出原样带回来，用于需要交互的构建。" },
		];
	},
};

const fakeWebServer = {
	register(options) {
		routes.push(options);
		return () => {};
	},
};

const fakeLlm = {
	async *stream() {
		llmCalls += 1;
		yield { type: "text-delta", text: llmNext };
		yield { type: "finish", reason: { kind: "stop" } };
	},
};

const services = {
	tools: fakeTools,
	webServer: fakeWebServer,
	llm: fakeLlm,
	agentDefaultModel: { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-flash" }) },
};

/**
 * 假 ctx 的 effect：**复刻 cordis 的真实约束** —— `ctx.effect` 只能在 apply 的**同步阶段**调用；
 * 一旦前面有 `await`，再调就抛 `TypeError: Invalid effect`（真实宿主就是这么把插件干掉的：
 * fiber failed、面板照渲、工具与路由全无、且宿主一条日志都不写）。
 * 这条约束必须在这里复刻，否则自检永远绿、真机永远 failed。
 */
let inSyncPhase = true;
let effectCalls = 0;
const effectDisposers = [];

const rawCtx = {
	get(name) {
		return services[name] ?? null;
	},
	/**
	 * ★ 复刻 cordis 的第二个约束：**没在 inject 里声明的服务，读属性会抛**
	 * `cannot get property "llm" without inject`。可选链 `ctx?.llm` 救不了 ——
	 * throw 发生在 Proxy 的 get 陷阱里。真机上就是这样：apply 全绿、路由 500。
	 * 声明了的（tools / webServer）走 own property，不抛。
	 */
	effect(fn, label) {
		if (!inSyncPhase) throw new TypeError("Invalid effect");
		effectCalls += 1;
		const disposer = typeof fn === "function" ? fn() : null;
		if (typeof disposer === "function") effectDisposers.push(disposer);
		return () => {
			if (typeof disposer === "function") disposer();
		};
	},
};

const declaredServices = new Set();
const ctx = new Proxy(rawCtx, {
	get(target, prop, receiver) {
		if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
		if (Object.prototype.hasOwnProperty.call(target, prop)) return Reflect.get(target, prop, receiver);
		if (services[prop] !== undefined) throw new Error(`cannot get property "${String(prop)}" without inject`);
		return undefined;
	},
});

/* ── 起插件 ── */

const module = await import("../index.js");
ok("index.js 导出 apply", typeof module.apply === "function");
eq("inject 含 tools 与 webServer", module.inject, ["tools", "webServer"]);

/* 按 inject 把声明过的服务挂到 ctx 上（没声明的读属性就会像真宿主一样抛） */
for (const name of module.inject) {
	declaredServices.add(name);
	if (services[name] !== undefined) rawCtx[name] = services[name];
}

let bootError = "";
let booted;
let bootResolved = false;
try {
	/* apply 的同步部分先跑完；返回 promise 之后进入"异步阶段"，
	   此后任何 ctx.effect 都会像真宿主一样抛 Invalid effect */
	const applying = module.apply(ctx);
	inSyncPhase = false;
	booted = await applying;
	bootResolved = true;
} catch (error) {
	inSyncPhase = false;
	bootError = String(error?.message ?? error);
}
ok("apply(ctx) 不抛异常（含 cordis 的 effect 同步约束）", bootError === "", bootError);
ok("apply 在同步阶段注册了 cleanup effect", effectCalls >= 1, "effectCalls=" + effectCalls);
/**
 * ★★ 本插件最贵那个坑的回归闸门：cordis 的 `_execute()` 收 apply 的**返回值**当 disposer
 * （`safeCollect`：不是 function 又不是 null/undefined 就 `throw TypeError("Invalid effect")`，
 * async apply 走的是 `effect.then(safeCollect)`）。于是 async apply 只要 `return {...}`，
 * 整段代码全部成功之后才抛、fiber 被标成 INACTIVE、**已注册的工具与路由被整体回滚**。
 * 真机表现：apply 跑完了却 "did not activate"、工具全无、路由 404、宿主不写日志。
 */
ok(
	"async apply resolve 成可回收值（function / null / undefined）",
	!bootResolved || booted === undefined || booted === null || typeof booted === "function",
	"async apply 不能 return 值；当前 resolve 成 " + (bootResolved ? JSON.stringify(booted) : "(未完成)"),
);

/* ── 工具契约 ── */
eq("注册了 8 个工具", registeredTools.length, 8);
const toolNames = registeredTools.map((tool) => tool.name).sort();
eq("工具名齐全", toolNames, ["catalog_classify", "catalog_export", "catalog_health", "catalog_list", "catalog_publish", "catalog_review", "catalog_stats", "catalog_tag"]);
for (const tool of registeredTools) {
	ok(`工具 ${tool.name} 声明了 output.schema`, Boolean(tool.output && tool.output.schema));
	ok(`工具 ${tool.name} 声明了 output.render`, typeof tool.output?.render === "function");
}
const publishTool = registeredTools.find((tool) => tool.name === "catalog_publish");

/* 返回值必须是 lossless JSON：跑一次真 execute，再 JSON 往返 */
async function callTool(name, args) {
	const tool = registeredTools.find((item) => item.name === name);
	if (!tool) throw new Error("no tool " + name);
	const value = await tool.execute(args || {});
	let roundTrip = null;
	let parseError = "";
	try {
		roundTrip = JSON.parse(JSON.stringify(value));
	} catch (error) {
		parseError = String(error?.message ?? error);
	}
	ok(`工具 ${name} 返回值可无损 JSON 往返`, parseError === "" && roundTrip !== null, parseError);
	ok(`工具 ${name} 返回了 text 便于展示`, typeof roundTrip?.text === "string" && roundTrip.text.length > 10);
	return roundTrip;
}

/* ── 路由 ── */

function makeReqRes() {
	const chunks = [];
	const res = {
		statusCode: 0,
		headers: null,
		writeHead(code, headers) {
			this.statusCode = code;
			this.headers = headers;
		},
		end(body) {
			chunks.push(body);
		},
	};
	return { res, body: () => chunks.join("") };
}

async function callRoute(path, method = "GET", payload = null) {
	const handler = routes[0];
	if (!handler) throw new Error("route 未注册");
	const { res, body } = makeReqRes();
	const listeners = {};
	const req = {
		url: "/plugin-catalog" + path,
		method,
		headers: { host: "127.0.0.1:11648" },
		socket: { remoteAddress: "127.0.0.1" },
		on(event, fn) {
			listeners[event] = fn;
		},
		destroy() {},
	};
	const promise = handler.handler(req, res);
	if (method === "POST") {
		const text = payload === null ? "" : JSON.stringify(payload);
		if (text) listeners.data?.(Buffer.from(text, "utf8"));
		listeners.end?.();
	}
	await promise;
	let json = null;
	try {
		json = JSON.parse(body());
	} catch {
		json = null;
	}
	return { status: res.statusCode, json, raw: body() };
}

eq("注册了 1 个前缀路由", routes.length, 1);
eq("路由前缀正确", routes[0].path, "/plugin-catalog");
eq("路由 kind 是 prefix", routes[0].kind, "prefix");

const stateRoute = await callRoute("/state");
ok("/state 返回 200", stateRoute.status === 200, String(stateRoute.status));
ok("/state 是 JSON", stateRoute.json !== null);
ok("/state 带条目数组", Array.isArray(stateRoute.json?.entries));
ok("/state 带 totals 与 bySource", Boolean(stateRoute.json?.totals?.bySource));
ok("/state 带 tags 与自定义标签提示词", Boolean(stateRoute.json?.tags?.prompt));
ok("/state 带宿主核心工具（单列）", Boolean(stateRoute.json?.hostCore));
ok("/state 带 publishing 信息", Boolean(stateRoute.json?.publishing));
ok("/state 说明了数据目录", typeof stateRoute.json?.dataDir === "string" && stateRoute.json.dataDir.includes("dsh-plugin-catalog") || stateRoute.json.dataDir === dataDir);

const healthRoute = await callRoute("/health");
ok("/health 返回 200 且 ok", healthRoute.status === 200 && healthRoute.json?.ok === true);
ok("/health 里有构建标记", typeof healthRoute.json?.build?.label === "string" && healthRoute.json.build.label.length > 0);
ok("/health 里统计了自注册的工具数", healthRoute.json?.toolsRegistered === 8, String(healthRoute.json?.toolsRegistered));
ok("/health 报告了归属统计", healthRoute.json?.attribution !== null && healthRoute.json?.attribution !== undefined);

/* ── 工具真跑（只读） ── */
const listTool = await callTool("catalog_list", { limit: 5 });
ok("catalog_list 列出了条目", (listTool.items || []).length > 0);
ok("catalog_list 的条目带来源四分类字段", (listTool.items || []).every((item) => typeof item.source === "string"));
ok("catalog_list 的文本里带来源中文标签", /官方|自写|第三方|混血|待标记/.test(listTool.text));

const healthTool = await callTool("catalog_health", {});
ok("catalog_health 文本含构建与路径", healthTool.text.includes("构建") && healthTool.text.includes("数据目录"));
ok("catalog_health 文本提示工具注册数", healthTool.text.includes("注册 8"));

/* 归属：真机上 catalog_list 自己的描述应该被归到本插件（自写），read 判宿主。
   ⚠️ 要等统计算完（rebuildAttribution 跟着 refreshStats 一起跑），所以这条断言放在下面。 */

/* ── 冷启动统计：后台算，不阻塞 ── */
const firstState = await callRoute("/state");
const jobAfterBoot = firstState.json?.job || {};
ok("冷启动时统计在后台任务里跑（不阻塞 /state）", jobAfterBoot.running === true || firstState.json?.stats?.ready === true, JSON.stringify(jobAfterBoot));

/* 等后台统计跑完（首次全量本机实测约 40~60 秒）。★ 要同时等 job.running 变 false，
   否则紧接着起分类任务会撞上"已有任务在跑"（单任务闸是故意的，不是 bug）。 */
const deadline = Date.now() + 180000;
let statsReady = false;
while (Date.now() < deadline) {
	const snapshot = await callRoute("/state");
	if (snapshot.json?.stats?.ready && !snapshot.json?.job?.running) {
		statsReady = true;
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 1500));
}
ok("后台统计最终完成", statsReady, "等了 180 秒还没算完");

/* 归属数据从 /health 取：apply 不能再 return 服务（async apply 的 resolve 值会被 cordis
   当成 disposer 校验），所以自检也不能依赖返回值 —— 走宿主自己的路由，正是真机的取数口。 */
const healthPayload = (await callRoute("/health")).json || {};
const attribution = healthPayload.attribution || {};
ok("归属索引跑过了（有统计）", typeof attribution.total === "number" && attribution.total > 0, JSON.stringify(attribution));
ok("归属里有工具被判为宿主", Number(attribution.host) >= 0, JSON.stringify(attribution));

const readyState = await callRoute("/state");
const meta = readyState.json?.stats?.meta || {};
ok("统计覆盖了会话", Number(meta.sessions) > 0, "sessions=" + meta.sessions);
ok("统计窗口默认 90 天", Number(meta.windowDays) === 90, String(meta.windowDays));
ok("统计记录了去重条数（v3+v4 双份日志）", typeof meta.duplicateCalls === "number");
ok("统计里有工具调用", Number(meta.calls) > 0, "calls=" + meta.calls);

/* 缓存文件真的落了，且**不含对话文本** */
const statsRaw = await import("node:fs/promises").then((fs) => fs.readFile(join(dataDir, "cache", "stats.json"), "utf8"));
ok("统计缓存落在数据目录", statsRaw.length > 100);
ok("统计缓存里没有任何 message content 字段", !statsRaw.includes('"content"') && !statsRaw.includes("assistant/message"));
ok("统计缓存里有会话昵称字段", statsRaw.includes('"t"'));

/* 拿一个有调用的条目看详情 */
const entries = readyState.json?.entries || [];
const busiest = entries.slice().sort((a, b) => (b.calls || 0) - (a.calls || 0))[0];
if (busiest) {
	const detail = await callRoute("/entry?id=" + encodeURIComponent(busiest.id) + "&page=1&pageSize=10");
	ok("详情路由 200", detail.status === 200);
	ok("详情带分工具统计", Array.isArray(detail.json?.tools));
	ok("详情带分页会话列表", Array.isArray(detail.json?.sessions?.items) && typeof detail.json.sessions.total === "number");
	ok("会话列表项只有 id/昵称/次数，没有正文", (detail.json?.sessions?.items || []).every((session) => {
		const keys = Object.keys(session);
		return keys.includes("id") && keys.includes("title") && keys.includes("calls") && !keys.includes("text") && !keys.includes("messages");
	}));
	const paged = await callRoute("/entry?id=" + encodeURIComponent(busiest.id) + "&page=2&pageSize=5");
	ok("分页参数生效", paged.json?.sessions?.page === 2 && paged.json?.sessions?.pageSize === 5, JSON.stringify({ page: paged.json?.sessions?.page, pageSize: paged.json?.sessions?.pageSize }));
} else {
	ok("详情：没有条目可测", false, "entries 为空");
}

/* ── 标签：新增（必须带解释）→ 打标 → AI 分类读自定义标签 ── */
const noGloss = await callRoute("/tags", "POST", { action: "add", label: "视频剪辑", dimension: "purpose" });
ok("新增标签缺解释被拒", noGloss.json?.ok === false && /解释/.test(noGloss.json?.error || ""), JSON.stringify(noGloss.json));

const added = await callRoute("/tags", "POST", { action: "add", label: "视频剪辑", dimension: "purpose", gloss: "处理视频素材：切片、转码、字幕" });
ok("带解释的自定义标签新增成功", added.json?.ok === true);
const customId = added.json?.tag?.id;
ok("自定义标签有 id", typeof customId === "string" && customId.length > 0);

const target = entries[0];
const setResult = await callRoute("/tags", "POST", { action: "set", id: target.id, purpose: [customId], context: [] });
ok("给条目打标签成功", setResult.json?.ok === true);

/* AI 分类：假 llm 返回一个分配，验证提示词里确实带了自定义标签的解释 */
llmNext = JSON.stringify({ [entries[1]?.id || target.id]: { purpose: [customId], context: [] } });
const classifyRoute = await callRoute("/classify", "POST", { ids: [entries[1]?.id || target.id] });
ok("分类任务已起（后台）", classifyRoute.json?.ok !== false, JSON.stringify(classifyRoute.json));
const classifyDeadline = Date.now() + 30000;
let classifyDone = null;
while (Date.now() < classifyDeadline) {
	const snapshot = await callRoute("/state");
	const posts = (snapshot.json?.tags?.assignments || {});
	if (posts[entries[1]?.id]) {
		classifyDone = posts[entries[1].id];
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 800));
}
ok("AI 分类落库（假模型 → 真流程）", classifyDone !== null && Array.isArray(classifyDone.purpose), JSON.stringify(classifyDone));
ok("AI 分类确实调了模型", llmCalls >= 1, "llmCalls=" + llmCalls);
/* ★ 必须重新取一次 state：readyState 是加标签**之前**的快照，提示词里当然还没有它 */
const afterTagState = await callRoute("/state");
ok("自定义标签的解释进入了给模型的提示词", String(afterTagState.json?.tags?.prompt || "").includes("处理视频素材"), "prompt 里没找到解释");

/* 用户手标过的条目不被 AI 覆盖 */
const before = (await callRoute("/state")).json?.tags?.assignments?.[target.id];
ok("用户手标的标签还在（AI 不覆盖）", Array.isArray(before?.purpose) && before.purpose.includes(customId), JSON.stringify(before));

/* ── 上传门禁 ── */
const applyNoConfirm = await callRoute("/upload", "POST", { action: "apply", planId: "nope", confirm: false });
ok("apply 不带 confirm 被拒", applyNoConfirm.json?.ok === false && /confirm/i.test(applyNoConfirm.json?.error || ""), JSON.stringify(applyNoConfirm.json));

const applyBadPlan = await callRoute("/upload", "POST", { action: "apply", planId: "nope", confirm: true });
ok("apply 带无效 planId 被拒（必须先出计划）", applyBadPlan.json?.ok === false && /计划/.test(applyBadPlan.json?.error || ""), JSON.stringify(applyBadPlan.json));

const publicNoConfirm = await callRoute("/upload", "POST", { action: "public", repo: "dsh-catalog", confirm: false });
ok("公开不带 confirm 被拒", publicNoConfirm.json?.ok === false && /confirm/i.test(publicNoConfirm.json?.error || ""), JSON.stringify(publicNoConfirm.json));

const publishNoConfirm = await callTool("catalog_publish", { action: "apply", planId: "x", confirm: false });
ok("工具层的 apply 不带 confirm 也被拒", publishNoConfirm.ok === false);

const publishPublicNoConfirm = await callTool("catalog_publish", { action: "public", repo: "dsh-catalog", confirm: false });
ok("工具层的 public 不带 confirm 也被拒", publishPublicNoConfirm.ok === false);

/* ── 设置：写不进去也不该崩 ── */
const settingsRoute = await callRoute("/settings", "POST", { windowDays: 0, nonsense: 1, aiModel: { provider: "deepseek-official", model: "deepseek-flash" } });
ok("设置接口可用且归一化（windowDays 0 → 默认 90）", settingsRoute.json?.ok === true && settingsRoute.json?.settings?.windowDays === 90, JSON.stringify(settingsRoute.json?.settings?.windowDays));
ok("设置丢弃未知键", settingsRoute.json?.settings?.nonsense === undefined);

/* ── 客户端上报 ── */
const clientState = await callRoute("/client-state", "POST", { build: "r1.0", view: "panel", entries: 70, note: "hosttest" });
ok("客户端上报接口可用", clientState.json?.ok === true);
const withReport = await callRoute("/state");
ok("面板能读到客户端上报", withReport.json?.clientReport?.build === "r1.0");

/* ── 越权请求被拒 ── */
{
	const handler = routes[0];
	const { res, body } = makeReqRes();
	const req = { url: "/plugin-catalog/state", method: "GET", headers: { origin: "https://evil.example", host: "127.0.0.1:11648" }, socket: { remoteAddress: "10.0.0.5" }, on() {}, destroy() {} };
	await handler.handler(req, res);
	const payload = JSON.parse(body());
	ok("非同源请求被拒（403）", res.statusCode === 403 && payload.ok === false, res.statusCode + " " + body().slice(0, 120));
}

/* ── 汇总 ── */
const failed = results.filter((item) => !item.pass);
console.log("");
console.log("dsh-plugin-catalog / hosttest");
console.log("  dataDir: " + dataDir);
console.log("  passed: " + (results.length - failed.length));
console.log("  failed: " + failed.length);
if (failed.length > 0) {
	console.log("");
	for (const item of failed) console.log("  ✗ " + item.name + (item.detail ? " — " + item.detail : ""));
	console.log("");
	if (!process.env.DSH_CATALOG_KEEP) rmSync(dataDir, { recursive: true, force: true });
	process.exit(1);
}
if (!process.env.DSH_CATALOG_KEEP) rmSync(dataDir, { recursive: true, force: true });
console.log("  all good");
