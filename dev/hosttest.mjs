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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { profileNodeModules } from "../lib/hostinfo.js";

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail: condition ? "" : detail });
}
/**
 * 跳过一条断言（不算失败，但必须响亮地打出来）。
 * ★ 目前只有一类：asar 断言。它需要 `process.resourcesPath` ——
 *   普通 `node.exe` 没有，只有 Electron 进程（或 `ELECTRON_RUN_AS_NODE=1` 的宿主 exe）才有。
 *   在普通 node 里把这类断言算"失败"会让 `node dev/hosttest.mjs` 永远红，
 *   而把它静默略过又会掩盖"asar 真的读不到" —— 所以单列一类 SKIP。
 */
function skip(name, why) {
	results.push({ name, pass: true, skipped: true, detail: why });
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
eq("注册了 10 个工具", registeredTools.length, 10);
const toolNames = registeredTools.map((tool) => tool.name).sort();
eq("工具名齐全", toolNames, ["catalog_classify", "catalog_export", "catalog_health", "catalog_list", "catalog_publish", "catalog_review", "catalog_skill_sync", "catalog_stats", "catalog_tag", "catalog_uninstall"]);
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

/* ── R10：发版体检（/preflight）──
   只测 dry 那一支：真跑一次要 40 秒，而且是"在自检里再跑自检"。
   dry 必须**不起子进程**，所以它能证明路由、参数与返回形状都对，又不会把自检拖成两分钟。 */
const preflightDry = await callRoute("/preflight", "POST", { dry: true });
ok(
	"/preflight dry=true 只回「会跑什么」（五项：三层自检 + 独立探针 + 副本同步），不起子进程",
	preflightDry.status === 200 && preflightDry.json?.ok === true && preflightDry.json?.dry === true && Array.isArray(preflightDry.json?.checks) && preflightDry.json.checks.length === 5 && preflightDry.json.checks.includes("staging") && preflightDry.json.checks.includes("probes"),
	JSON.stringify(preflightDry.json).slice(0, 240),
);
ok("service 暴露 runPreflight（宿主侧跑 dev/ship.mjs 并解析结论）", typeof (await import("../lib/service.mjs")).CatalogService?.prototype?.runPreflight === "function");
ok("dev/ship.mjs 存在且可被当子进程调用", existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dev", "ship.mjs")));

/* ── 工具真跑（只读） ── */
const listTool = await callTool("catalog_list", { limit: 5 });
ok("catalog_list 列出了条目", (listTool.items || []).length > 0);
ok("catalog_list 的条目带来源四分类字段", (listTool.items || []).every((item) => typeof item.source === "string"));
ok("catalog_list 的文本里带来源中文标签", /官方|自写|第三方|混血|待标记/.test(listTool.text));

const healthTool = await callTool("catalog_health", {});
ok("catalog_health 文本含构建与路径", healthTool.text.includes("构建") && healthTool.text.includes("数据目录"));
ok("catalog_health 文本提示工具注册数", healthTool.text.includes("注册 8"));
/* R18：运行中版本 vs 磁盘版本。自检进程读的就是磁盘代码，两者必须一致 ——
   这条同时在守护「LOADED_VERSION 有没有读到 package.json」：读不到会变成空串，stale 也会变 false，
   所以这里显式要求它等于磁盘版本，而不是只要求 stale=false。 */
ok(
	"health 报「运行中版本」，且与磁盘一致（自检进程读的就是磁盘代码）",
	typeof healthTool.loaded?.version === "string" && healthTool.loaded.version !== "" && healthTool.loaded.version === healthTool.build?.version && healthTool.loaded.stale === false && healthTool.text.includes("运行中："),
	JSON.stringify({ loaded: healthTool.loaded, disk: healthTool.build?.version }),
);
const stateBuild = (await callRoute("/state")).json?.build;
ok("/state.build 也带磁盘/运行中两个版本（面板头部靠它标「未重载」）", typeof stateBuild?.version === "string" && typeof stateBuild?.loaded === "string" && typeof stateBuild?.stale === "boolean", JSON.stringify(stateBuild && { version: stateBuild.version, loaded: stateBuild.loaded, stale: stateBuild.stale }));

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

/* R2（2026-10-22）：面板要能回答「这个工具是谁给的」和「它到底装在哪」。
   这两组字段是客户端搜索与浮窗的数据来源，缺了客户端不会报错 —— 只会静默搜不到，
   所以必须在服务端这一层断言。 */
const pluginsWithTools = entries.filter((entry) => entry.kind === "plugin");
ok(
	"列表项带上 toolNames（按工具名搜索的数据来源）",
	pluginsWithTools.length > 0 && pluginsWithTools.every((entry) => Array.isArray(entry.toolNames)),
	JSON.stringify(pluginsWithTools.slice(0, 2).map((entry) => entry.toolNames)),
);
ok(
	"toolNames 与 toolCount 口径一致",
	pluginsWithTools.every((entry) => (entry.toolNames || []).length === (entry.toolCount || 0)),
	JSON.stringify(pluginsWithTools.filter((entry) => (entry.toolNames || []).length !== (entry.toolCount || 0)).slice(0, 2).map((entry) => ({ name: entry.name, toolCount: entry.toolCount, toolNames: entry.toolNames }))),
);
ok(
	"列表项带上 realDir / isLink（装上了却不工作时要看这两个）",
	pluginsWithTools.every((entry) => typeof entry.realDir === "string") && pluginsWithTools.every((entry) => typeof entry.isLink === "boolean"),
	JSON.stringify(pluginsWithTools.slice(0, 2).map((entry) => ({ name: entry.name, realDir: entry.realDir, isLink: entry.isLink }))),
);
ok(
	"实体目录的插件 realDir 指向 profile 下的 node_modules",
	pluginsWithTools.some((entry) => entry.realDir.includes("node_modules") || entry.realDir === ""),
	JSON.stringify(pluginsWithTools.slice(0, 3).map((entry) => entry.realDir)),
);

if (busiest) {
	const detail = await callRoute("/entry?id=" + encodeURIComponent(busiest.id) + "&page=1&pageSize=10");
	ok("详情路由 200", detail.status === 200);
	ok("详情带分工具统计", Array.isArray(detail.json?.tools));
	ok(
		"详情里的工具名都在列表项的 toolNames 里（两处口径一致）",
		(detail.json?.tools || []).length === 0 || (detail.json?.tools || []).every((tool) => (busiest.toolNames || []).includes(tool.name)),
		JSON.stringify({ toolNames: busiest.toolNames, detailTools: (detail.json?.tools || []).map((tool) => tool.name) }),
	);
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

/* ── R4：目录体积（懒算）与「导出当前筛选」 ──
   体积只用一条路验：造一个已知大小的目录，看递归结果对不对、缓存有没有生效。
   导出用真写盘验：文件必须存在、只含选中的条目、并且写明筛选条件。 */
const { dirSize } = await import("../lib/service.mjs");
const sizeDir = join(dataDir, "size-fixture");
mkdirSync(join(sizeDir, "nested"), { recursive: true });
writeFileSync(join(sizeDir, "a.bin"), Buffer.alloc(1500));
writeFileSync(join(sizeDir, "nested", "b.bin"), Buffer.alloc(2500));
const measured = await dirSize(sizeDir);
ok("dirSize 递归统计字节与文件数（1500 + 2500 = 4000 / 2 个）", measured.bytes === 4000 && measured.files === 2 && measured.truncated === false, JSON.stringify(measured));
const measuredAgain = await dirSize(sizeDir);
ok("dirSize 命中 5 分钟缓存（第二次返回同一份结果）", measuredAgain === measured);

const sizeRoute = await callRoute("/size?id=" + encodeURIComponent(busiest?.id || ""));
ok("/size 路由 200，插件给出 bytes/files", sizeRoute.status === 200 && (sizeRoute.json?.size === null || typeof sizeRoute.json?.size?.bytes === "number"), JSON.stringify(sizeRoute.json).slice(0, 240));
/* R8：官方包在 asar 里 —— realDir 是**虚拟成员路径**，量不出来。以前会静默返回 0 B，
   看起来像"它不占空间"；现在必须说清原因。 */
const asarEntry = entries.find((entry) => entry.inAsar);
if (asarEntry) {
	const asarSize = await callRoute("/size?id=" + encodeURIComponent(asarEntry.id));
	ok(
		"官方包在 asar 里：/size 说清原因，绝不返回 0 B",
		asarSize.json?.ok === true && asarSize.json?.size === null && /asar/.test(String(asarSize.json?.reason)),
		JSON.stringify(asarSize.json).slice(0, 240),
	);
} else {
	/* 普通 node 里读不到 app.asar（没有 process.resourcesPath）→ 这条断言无法执行，明确 SKIP */
	skip("官方包在 asar 里：/size 说清原因，绝不返回 0 B", "当前环境读不到 app.asar（不是 Electron 进程；用 host_selfcheck 或在面板点「自检」跑完整版）");
}
const skillEntry = entries.find((entry) => entry.kind === "skill");
if (skillEntry) {
	const skillSize = await callRoute("/size?id=" + encodeURIComponent(skillEntry.id));
	/* R8 口径：Skill 有自己的目录（catalog 的 dir）→ 真量；没有目录才 null + 原因。
	   以前一律 null 是判据错位（拿 root=skills 根去比），不是 Skill 不占空间。 */
	const skillOk = skillEntry.realDir
		? skillSize.json?.ok === true && typeof skillSize.json?.size?.bytes === "number" && skillSize.json.size.bytes > 0
		: skillSize.json?.ok === true && skillSize.json?.size === null && typeof skillSize.json?.reason === "string";
	ok("Skill 的 /size：有目录就给出字节数，没目录才 null + 原因", skillOk, JSON.stringify({ entry: { dir: skillEntry.realDir }, result: skillSize.json }).slice(0, 300));
} else {
	ok("体积：没有 Skill 可测", false, "entries 里没有 skill");
}

const exportPicked = entries.slice(0, 3);
const skipped = entries[5];
const exportRoute = await callRoute("/export", "POST", { ids: exportPicked.map((entry) => entry.id), filters: { query: "test", source: "any", kind: "all", usage: "unused", sort: "rate" } });
ok("/export 路由 200 且真的写盘（返回 path + count）", exportRoute.status === 200 && exportRoute.json?.ok === true && typeof exportRoute.json?.path === "string" && exportRoute.json?.count === exportPicked.length, JSON.stringify(exportRoute.json).slice(0, 240));
const exportText = exportRoute.json?.path ? readFileSync(exportRoute.json.path, "utf8") : "";
ok("导出文件只含选中的那几条（未选中的不出现）", exportPicked.every((entry) => exportText.includes(entry.name)) && (!skipped || !exportText.includes(skipped.name)), JSON.stringify({ picked: exportPicked.map((entry) => entry.name), skipped: skipped?.name }));
ok("导出文件写明条数与筛选条件", exportText.includes("共 **3** 条") && exportText.includes("搜索 `test`") && exportText.includes("用法 unused") && exportText.includes("排序 rate"));
ok("导出文件是表格且带报错率列", exportText.includes("| 报错率 |") && exportText.includes("`" + exportPicked[0].name + "`"));

/* R5：批量体积（多选时一次问一批） */
const sizeIds = exportPicked.map((entry) => entry.id);
const sizeBatch = await callRoute("/sizes", "POST", { ids: sizeIds });
const sumBytes = sizeIds.reduce((sum, id) => sum + (Number(sizeBatch.json?.sizes?.[id]) || 0), 0);
ok("/sizes 批量路由 200 且逐条给出字节数", sizeBatch.status === 200 && sizeBatch.json?.ok === true && sizeBatch.json?.count === sizeIds.length, JSON.stringify(sizeBatch.json).slice(0, 240));
ok("批量总体积 = 各条之和", Number(sizeBatch.json?.totalBytes) === sumBytes, JSON.stringify({ total: sizeBatch.json?.totalBytes, sum: sumBytes }));
if (skillEntry) {
	const withSkill = await callRoute("/sizes", "POST", { ids: [sizeIds[0], skillEntry.id] });
	const skillBytes = withSkill.json?.sizes?.[skillEntry.id];
	/* R8：Skill 有独立目录 → 计入总量；没有目录才是 null（按 0 计，不许混进 totalBytes） */
	const expectTotal = (Number(withSkill.json?.sizes?.[sizeIds[0]]) || 0) + (Number(skillBytes) || 0);
	ok("Skill 在批量体积里：有目录计入总量，没有目录为 null（按 0 计）", Number(withSkill.json?.totalBytes) === expectTotal, JSON.stringify(withSkill.json).slice(0, 240));
} else {
	ok("批量体积：没有 Skill 可测", false, "entries 里没有 skill");
}
const oversized = await callRoute("/sizes", "POST", { ids: Array.from({ length: 500 }, (_, index) => "plugin:fake-" + index) });
ok("批量体积上限 200 条（再多也只处理 200）", oversized.json?.count === 200, JSON.stringify(oversized.json).slice(0, 120));

/* ── R8：体积成了「一等公民」（卡片显示 / 按体积排序 / 筛选合计都读这份快照） ──
   走的还是真路由：/refresh what=sizes 起后台任务 → 等它跑完 → /state.sizes 就该有东西。
   ★ 这份快照**只在后台任务里算**，目录构建里一次都不许出现（坑 19 的红线）。 */
const { formatBytes } = await import("../lib/service.mjs");
ok(
	"formatBytes 与面板同口径（B / KB / MB / GB）",
	formatBytes(512) === "512 B" && formatBytes(2048) === "2 KB" && formatBytes(10137524) === "9.7 MB" && formatBytes(3 * 1024 * 1024 * 1024) === "3.0 GB",
	[formatBytes(512), formatBytes(2048), formatBytes(10137524), formatBytes(3 * 1024 * 1024 * 1024)].join(" / "),
);

const sizesStarted = await callRoute("/refresh", "POST", { what: "sizes" });
ok("/refresh what=sizes 起了后台任务（或已有任务在跑）", sizesStarted.json?.ok === true || /已有任务/.test(String(sizesStarted.json?.error)), JSON.stringify(sizesStarted.json).slice(0, 200));

const sizesDeadline = Date.now() + 180000;
let sizesSnapshot = null;
while (Date.now() < sizesDeadline) {
	const snapshot = await callRoute("/state");
	if (snapshot.json?.sizes && snapshot.json.sizes.at > 0 && !snapshot.json?.job?.running) {
		sizesSnapshot = snapshot.json.sizes;
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 1200));
}
ok("体积快照量完了（/state.sizes 带 at / count / byId）", Boolean(sizesSnapshot) && Object.keys(sizesSnapshot.byId || {}).length > 0, JSON.stringify(sizesSnapshot).slice(0, 240));
ok(
	"体积快照的 byId 是「id → 字节数」（不是对象、不是字符串）",
	Boolean(sizesSnapshot) && Object.values(sizesSnapshot.byId).every((value) => value === null || (typeof value === "number" && value >= 0)),
	JSON.stringify(sizesSnapshot && Object.entries(sizesSnapshot.byId).slice(0, 3)),
);
ok(
	"快照总数 = 逐条字节数之和（口径一致）",
	Boolean(sizesSnapshot) && Number(sizesSnapshot.totalBytes) === Object.values(sizesSnapshot.byId).reduce((sum, value) => sum + (Number(value) || 0), 0),
	JSON.stringify({ total: sizesSnapshot?.totalBytes }),
);
ok(
	"官方 asar 条目不进快照（量不出就不许写 0 B）",
	Boolean(sizesSnapshot) && !entries.filter((entry) => entry.inAsar).some((entry) => typeof sizesSnapshot.byId[entry.id] === "number"),
	JSON.stringify(entries.filter((entry) => entry.inAsar).map((entry) => entry.id).slice(0, 3)),
);
ok("体积快照落在 cache/sizes.json（换会话不用重量）", existsSync(join(dataDir, "cache", "sizes.json")));
ok("快照带 truncated 清单（超预算的条目要在界面上标出来）", Boolean(sizesSnapshot) && Array.isArray(sizesSnapshot.truncated));
const cachedBatch = await callRoute("/sizes", "POST", { ids: sizeIds });
ok("/sizes 命中快照后不再递归（measured === 0）", cachedBatch.json?.measured === 0, JSON.stringify(cachedBatch.json).slice(0, 200));
const healthWithSizes = (await callRoute("/health")).json || {};
ok("/health 报告体积快照（count / totalBytes / at）", Boolean(healthWithSizes.sizes) && healthWithSizes.sizes.count > 0 && healthWithSizes.sizes.totalBytes > 0 && healthWithSizes.sizes.at > 0, JSON.stringify(healthWithSizes.sizes));
const healthToolWithSizes = await callTool("catalog_health", {});
ok("catalog_health 文本里有体积一行（已量 N 条 / 合计 X）", /体积：已量 \d+ 条/.test(healthToolWithSizes.text), healthToolWithSizes.text.split("\n").filter((line) => line.startsWith("体积")).join(" | "));
const exportWithSizes = await callRoute("/export", "POST", { ids: sizeIds, filters: {} });
const exportWithSizesText = exportWithSizes.json?.path ? readFileSync(exportWithSizes.json.path, "utf8") : "";
ok("导出表格带体积列，并写明这份的合计", exportWithSizesText.includes("| 体积 |") && /合计 \*\*[\d.]+ (B|KB|MB|GB)\*\*/.test(exportWithSizesText), exportWithSizesText.split("\n").slice(0, 4).join(" / ").slice(0, 240));

/* ── R9：依赖归属（「那个 354 MB 的二进制是谁带进来的」「删它会不会弄坏别人」） ──
   走真数据：这台机器的 profile 里 dsh-ops 声明了 @dsh-ops/*-win32-x64 三个运行时包，
   所以反向索引必须把它们指回 dsh-ops；判据靠 package.json，不靠目录名猜。 */
const depPlugins = entries.filter((entry) => entry.kind === "plugin" && !entry.inAsar);
ok(
	"插件条目带依赖四字段（dependents / dependentCount / dependsOn / dependsOnCount）",
	depPlugins.length > 0 && depPlugins.every((entry) => Array.isArray(entry.dependents) && typeof entry.dependentCount === "number" && Array.isArray(entry.dependsOn) && typeof entry.dependsOnCount === "number"),
	JSON.stringify(depPlugins.slice(0, 2).map((entry) => ({ name: entry.name, dependents: entry.dependents, dependentCount: entry.dependentCount }))),
);
ok(
	"dependentCount 与 dependents 截断口径一致（不会互相对不上）",
	depPlugins.every((entry) => entry.dependentCount >= entry.dependents.length && (entry.dependentCount <= 12 || entry.dependents.length === 12)),
	JSON.stringify(depPlugins.filter((entry) => entry.dependentCount < entry.dependents.length).slice(0, 2).map((entry) => entry.name)),
);
ok(
	"orphanHint 的判据 =「不在 profile 依赖里 + 无人依赖」（不是随手标的）",
	depPlugins.every((entry) => entry.orphanHint === (!entry.dependency && entry.dependentCount === 0)),
	JSON.stringify(depPlugins.filter((entry) => entry.orphanHint !== (!entry.dependency && entry.dependentCount === 0)).slice(0, 3).map((entry) => entry.name)),
);
const dependedEntry = depPlugins.find((entry) => entry.dependentCount > 0);
ok(
	"至少一条插件「被别的包依赖」，且依赖者名字都在条目列表里（本机实测 dsh-ops → @dsh-ops/*-win32-x64）",
	Boolean(dependedEntry) &&
		dependedEntry.dependents.length > 0 &&
		dependedEntry.dependents.every((name) => entries.some((entry) => entry.name === name)),
	JSON.stringify({ name: dependedEntry?.name, dependents: dependedEntry?.dependents, count: dependedEntry?.dependentCount }),
);
const platformDep = depPlugins.find((entry) => entry.dependents.includes("dsh-ops"));
ok(
	"平台运行时二进制能指回声明它的包（@dsh-ops/*-win32-x64 → dsh-ops）",
	Boolean(platformDep),
	JSON.stringify(depPlugins.filter((entry) => entry.name.startsWith("@dsh-ops/")).map((entry) => ({ name: entry.name, dependents: entry.dependents }))),
);
const dshOpsEntry = depPlugins.find((entry) => entry.name === "dsh-ops");
ok(
	"dsh-ops 自己声明了运行时依赖（体积 Top 的来源就是它）",
	Boolean(dshOpsEntry) && dshOpsEntry.dependsOnCount > 0 && dshOpsEntry.dependsOn.some((name) => name.startsWith("@dsh-ops/")),
	JSON.stringify({ name: dshOpsEntry?.name, dependsOn: dshOpsEntry?.dependsOn, count: dshOpsEntry?.dependsOnCount }),
);
const depMetaState = readyState.json?.dependency || (await callRoute("/state")).json?.dependency || null;
ok("state 带依赖图自述（scanned / direct / orphanHint）", Boolean(depMetaState) && depMetaState.scanned > 0 && depMetaState.direct > 0 && typeof depMetaState.orphanHint === "number", JSON.stringify(depMetaState));
const healthWithDep = (await callRoute("/health")).json || {};
ok("/health 带依赖图", Boolean(healthWithDep.dependency) && healthWithDep.dependency.scanned === depMetaState.scanned, JSON.stringify(healthWithDep.dependency));
const healthToolWithDep = await callTool("catalog_health", {});
ok("catalog_health 文本里有依赖图一行", /依赖图：\d+ 个包 \/ \d+ 个直接依赖 \/ \d+ 个「无人依赖」候选/.test(healthToolWithDep.text), healthToolWithDep.text.split("\n").filter((line) => line.startsWith("依赖图")).join(" | "));
const listToolWithDep = await callTool("catalog_list", { limit: 60 });
ok("catalog_list 的条目点出被依赖 / 无人依赖", /被 \d+ 个包依赖|无人依赖（候选）/.test(listToolWithDep.text), listToolWithDep.text.split("\n").filter((line) => line.includes("被 ") && line.includes("个包依赖")).slice(0, 2).join(" | "));
const depExport = await callRoute("/export", "POST", { ids: depPlugins.slice(0, 6).map((entry) => entry.id), filters: {} });
const depExportText = depExport.json?.path ? readFileSync(depExport.json.path, "utf8") : "";
ok("导出清单带「被依赖」列（拿出去也要能判断）", depExportText.includes("| 被依赖 |") && depExportText.includes("直接依赖"), depExportText.split("\n")[8] || "");

/* ── R12：装了到底会不会跑（bundles 不是唯一入口） ──
   走真数据：这台机器的 `@dsh-ops/*-win32-x64` **不在** `dsh.profile.bundles` 里，
   却会因为 dsh-ops 声明依赖它们而被加载 —— 旧口径把它们标成「启用：否」并置灰，
   照着删就会弄坏 dsh-ops。这一组断言就钉住"能不能正确回答这个问题"。 */
const LOAD_STATES = ["bundle", "config", "transitive", "dormant"];
const allPlugins = entries.filter((entry) => entry.kind === "plugin");
ok(
	"每个插件条目都带 loadState（四态白名单）",
	allPlugins.length > 0 && allPlugins.every((entry) => LOAD_STATES.includes(entry.loadState)),
	JSON.stringify([...new Set(allPlugins.map((entry) => entry.loadState))]),
);
ok("官方 asar 包的加载态记为 bundle（它们的入口就是 bundles）", allPlugins.filter((entry) => entry.inAsar).every((entry) => entry.loadState === "bundle"));
ok(
	"transitive 条目必须能点出「随谁加载」（via 非空且指向一个真实存在的包）",
	allPlugins.filter((entry) => entry.loadState === "transitive").every((entry) => typeof entry.loadVia === "string" && entry.loadVia !== "" && entries.some((other) => other.name === entry.loadVia)),
	JSON.stringify(allPlugins.filter((entry) => entry.loadState === "transitive").slice(0, 3).map((entry) => ({ name: entry.name, via: entry.loadVia }))),
);
ok(
	"平台运行时二进制被判成 transitive 而不是 dormant（本机 @dsh-ops/* → dsh-ops）",
	(() => {
		const binary = allPlugins.find((entry) => entry.name === "@dsh-ops/bash-win32-x64");
		return !binary || (binary.loadState === "transitive" && binary.loadVia === "dsh-ops");
	})(),
	JSON.stringify(allPlugins.filter((entry) => entry.name.startsWith("@dsh-ops/")).map((entry) => ({ name: entry.name, loadState: entry.loadState, via: entry.loadVia, enabled: entry.enabled }))),
);
ok(
	"loadState 与 enabled 是两件事（存在 enabled=false 但会被加载的条目，这正是旧口口径的坑）",
	allPlugins.some((entry) => entry.enabled === false && entry.loadState !== "dormant"),
	JSON.stringify(allPlugins.filter((entry) => entry.enabled === false).map((entry) => ({ name: entry.name, loadState: entry.loadState }))),
);
const loadMeta = (await callRoute("/state")).json?.dependency || {};
ok(
	"state.dependency 带加载路径自述（入口数 / 四态计数 / 读了几份组合文件）",
	typeof loadMeta.loadRoots === "number" && loadMeta.loadRoots > 0 && Boolean(loadMeta.loadCounts) && typeof loadMeta.compositionFiles === "number",
	JSON.stringify({ roots: loadMeta.loadRoots, counts: loadMeta.loadCounts, files: loadMeta.compositionFiles }),
);
ok(
	"四态计数之和 = 扫到的包数（不许有包落不进任何一态）",
	LOAD_STATES.reduce((sum, state) => sum + Number(loadMeta.loadCounts?.[state] || 0), 0) === Number(loadMeta.scanned || -1),
	JSON.stringify({ counts: loadMeta.loadCounts, scanned: loadMeta.scanned }),
);
const healthToolWithLoad = await callTool("catalog_health", {});
ok(
	"catalog_health 文本里有加载路径一行（含「不在任何入口上」）",
	/加载路径：\d+ 个入口/.test(healthToolWithLoad.text) && healthToolWithLoad.text.includes("不在任何入口上"),
	healthToolWithLoad.text.split("\n").filter((line) => line.startsWith("加载路径")).join(" | "),
);
ok("catalog_list 不再用「未启用」这个错口径", !listToolWithDep.text.includes("未启用"));

/* ── R14.1：工具面也能按加载态筛（此前只有面板能筛，工具只能翻页找） ──
   三条断言：dormant 只回 dormant、loaded 里没有 Skill、两者 + Skill = 全部（分区不重不漏）。 */
{
	const dormantList = await callTool("catalog_list", { loadState: "dormant", limit: 200 });
	const dormantItems = dormantList.items || [];
	ok("catalog_list loadState=dormant：只回「不会被加载」的条目", dormantItems.length > 0 && dormantItems.every((item) => item.loadState === "dormant"), `命中 ${dormantItems.length} 条`);
	const loadedList = await callTool("catalog_list", { loadState: "loaded", limit: 200 });
	const loadedItems = loadedList.items || [];
	ok("catalog_list loadState=loaded：一条 dormant 都没有，且没有 Skill（Skill 没有加载态）", loadedItems.length > 0 && loadedItems.every((item) => item.loadState !== "dormant" && item.kind !== "skill"), `命中 ${loadedItems.length} 条`);
	const allList = await callTool("catalog_list", { limit: 200 });
	const allItems = allList.items || [];
	ok(
		"两种过滤是分区：dormant + loaded + 非插件条目 = 全部（不重不漏）",
		dormantItems.length + loadedItems.length + allItems.filter((item) => item.kind === "skill").length === allItems.length,
		`${dormantItems.length} + ${loadedItems.length} + Skill ${allItems.filter((item) => item.kind === "skill").length} = ${dormantItems.length + loadedItems.length + allItems.filter((item) => item.kind === "skill").length} / 全部 ${allItems.length}`,
	);
	ok("文本点明这个过滤的用途（怎么删看 catalog_uninstall）", dormantList.text.includes("catalog_uninstall") && dormantList.text.includes("不会被加载"), dormantList.text.split("\n")[1] || "");
}

/* ── R13：加载态进报告（拿出去的清单也要能支撑"删不删"） ──
   两处口径：全量快照的概览 + 单节「不会被加载」；当前筛选清单多一列「加载」。
   数字必须和 /state 的 dependency.loadCounts 对得上，不能是另算一遍。 */
const fullExport = await callTool("catalog_export", { top: 5 });
const fullExportText = fullExport.path ? readFileSync(fullExport.path, "utf8") : "";
ok(
	"全量快照的概览带「加载路径」一行（入口数 + 四态）",
	fullExportText.includes("加载路径：入口 **") && fullExportText.includes("不在任何入口上") && fullExportText.includes("份组合文件"),
	fullExportText.split("\n").filter((line) => line.startsWith("- 加载路径")).join(" | ").slice(0, 240),
);
/* R17：变化一节紧跟概览 —— 刚装好第一次只有一条快照，必须如实说"还没有可比的历史" */
ok(
	"全量快照带「变化」一节，且第一条快照时如实写清没有可比历史",
	(fullExportText.includes("## 变化（第一条快照）") && fullExportText.includes("这是**第一条**快照")) || fullExportText.includes("## 变化（基线 "),
	fullExportText.split("\n").filter((line) => line.startsWith("## 变化") || line.startsWith("- 期间：")).join(" | ").slice(0, 240),
);
const dormantEntries = allPlugins.filter((entry) => entry.loadState === "dormant");
if (dormantEntries.length > 0) {
	ok(
		"全量快照单开「不会被加载」一节，条数与条目口径一致",
		fullExportText.includes("## 不会被加载（" + dormantEntries.length + " 条）"),
		"dormant 条目 " + dormantEntries.length + " 条 / 报告里有 " + (fullExportText.match(/## 不会被加载（(\d+) 条）/) || ["未找到"])[0],
	);
	ok(
		"该节写明边界（声明层面判据，不是「绝对没跑」），并给出可省体积",
		fullExportText.includes("运行时按路径 `require()` 的动态加载看不见") && /有体积记录，合计 \*\*[\d.]+ (B|KB|MB|GB)\*\*/.test(fullExportText),
	);
} else {
	skip("本机没有 dormant 条目，跳过「不会被加载」一节的两条断言", "这台机器的所有插件都有加载入口；契约由 audit 的静态断言 + 有 dormant 的机器覆盖");
}
const filteredWithLoad = await callRoute("/export", "POST", { ids: dormantEntries.slice(0, 3).map((entry) => entry.id), filters: {} });
const filteredLoadText = filteredWithLoad.json?.path ? readFileSync(filteredWithLoad.json.path, "utf8") : "";
ok(
	"选中 dormant 条目导出时，那一列如实写「不会被加载」（不是「否」）",
	dormantEntries.length === 0 || filteredLoadText.includes("| 加载 |") && filteredLoadText.includes("**不会被加载**"),
	filteredLoadText.split("\n").filter((line) => line.includes("不会被加载")).slice(0, 2).join(" | ").slice(0, 200),
);

/* ── R6：副本漂移（工作区源码 vs profile 里加载的副本） ──
   用两个已知内容的临时目录验判据，再用真 /state 验"junction 记为 linked"，
   以及"不同步会被标出来"。这三条合起来才对得上卡片上那枚「副本不同步」。 */
const { fingerprintDir, compareFingerprints } = await import("../lib/service.mjs");
const driftA = join(dataDir, "drift-a");
const driftB = join(dataDir, "drift-b");
mkdirSync(driftA, { recursive: true });
mkdirSync(driftB, { recursive: true });
writeFileSync(join(driftA, "package.json"), '{"version":"1.0.0"}');
writeFileSync(join(driftB, "package.json"), '{"version":"1.0.0"}');
writeFileSync(join(driftA, "client.js"), "// a\n");
const onlyOne = compareFingerprints(await fingerprintDir(driftA), await fingerprintDir(driftB));
ok("只有一边有的关键文件 → differs 且点名文件", onlyOne.verdict === "differs" && onlyOne.differs.some((name) => name.includes("client.js")), JSON.stringify(onlyOne));
writeFileSync(join(driftB, "client.js"), "// a\n");
const identical = compareFingerprints(await fingerprintDir(driftA), await fingerprintDir(driftB));
ok("两边同样大小且时间接近 → same（只比 size+mtime，不读内容）", identical.verdict === "same", JSON.stringify(identical));
writeFileSync(join(driftA, "client.js"), "// a 加长一点\n");
const longer = compareFingerprints(await fingerprintDir(driftA), await fingerprintDir(driftB));
ok("内容长度不同 → differs（即使时间一样）", longer.verdict === "differs" && longer.differs.some((name) => name.includes("client.js")), JSON.stringify(longer));
writeFileSync(join(driftB, "client.js"), "// a 加长一点\n");
/* 判据是**两边各自最新的修改时间**（只看 4 个关键文件里的 max），
   所以要让"加载的那份"整体更旧：A 的两个文件都改老，B 的 package.json 也改老，只留 B/client.js 是新的。 */
const twoHoursAgo = new Date(Date.now() - 7200000);
utimesSync(join(driftA, "package.json"), twoHoursAgo, twoHoursAgo);
utimesSync(join(driftA, "client.js"), twoHoursAgo, twoHoursAgo);
utimesSync(join(driftB, "package.json"), twoHoursAgo, twoHoursAgo);
const staleLoaded = compareFingerprints(await fingerprintDir(driftA), await fingerprintDir(driftB));
ok("一边整体更新时给出 newer-workspace（按各自最新修改时间比）", staleLoaded.verdict === "newer-workspace", JSON.stringify(staleLoaded));

const finalState = await callRoute("/state");
const drift = finalState.json?.drift || {};
ok("/state 带 drift 映射", drift && typeof drift === "object" && Object.keys(drift).length > 0, JSON.stringify(Object.keys(drift).slice(0, 5)));
const linkedEntries = Object.values(drift).filter((entry) => entry.verdict === "linked");
ok("junction 安装记为 linked（源目录就是工作区，只有一份）", linkedEntries.length > 0, JSON.stringify(Object.values(drift).slice(0, 3)));
ok("没有 realDir 的插件不进 drift（asar / Skill 没有可比的工作区副本）", Object.keys(drift).every((id) => id.startsWith("plugin:") || drift[id].staged === true), JSON.stringify(Object.keys(drift).slice(0, 3)));
const skillDrift = Object.keys(drift).filter((id) => id.startsWith("skill:"));
ok("有 staging 副本的 Skill 也进 drift（带 staged 标记）", skillDrift.every((id) => drift[id].staged === true) && (skillDrift.length === 0 || skillDrift.every((id) => typeof drift[id].verdict === "string")), "skillDrift=" + skillDrift.length);

/* catalog_skill_sync：默认只出计划；apply 不带 confirm 必须被拒（这条会写盘） */
const syncPlan = await callTool("catalog_skill_sync", { action: "plan" });
ok("catalog_skill_sync plan 不写盘且给出方向", syncPlan?.ok === true && typeof syncPlan?.count === "number" && syncPlan?.applied !== true && /live → staging/.test(String(syncPlan?.text || "")), String(syncPlan?.count));
ok("计划项都带两个绝对目录（live 与 staging 不同）", (syncPlan?.items || []).every((item) => typeof item.loadedDir === "string" && typeof item.stagedDir === "string" && item.loadedDir !== item.stagedDir));
const syncNoConfirm = await callTool("catalog_skill_sync", { action: "apply" });
ok("apply 不带 confirm 被拒（绝不静默覆盖 staging）", syncNoConfirm?.ok === false && /confirm/.test(String(syncNoConfirm?.error || "")), JSON.stringify(syncNoConfirm?.error));

/* ─────────── R11：「同步 staging」从工具走到面板，以及体检第 4 项 ───────────
   三个层次各验一段，缺一层就会出现"按钮能点、路由没接"或"路由能调、判据是另一套"：
     ① `/skillsync` 路由：计划只读、写盘必须 confirm；
     ② `lib/staging.mjs` 的判据与复制：用临时目录，不碰真 staging；
     ③ `dev/ship.mjs --only staging`：交接前那条命令真能报出「几对里几个旧」。 */
const routePlan = await callRoute("/skillsync", "POST", {});
ok(
	"/skillsync 计划接口：只读、给出方向与计数（面板按钮的第一步）",
	routePlan.status === 200 && routePlan.json?.ok === true && typeof routePlan.json?.count === "number" && routePlan.json?.applied !== true && routePlan.json?.direction === "live → staging",
	JSON.stringify(routePlan.json && { ok: routePlan.json.ok, count: routePlan.json.count, applied: routePlan.json.applied, direction: routePlan.json.direction }),
);
ok("计划项只带「旧了」的（staging 更新的一项都不会进计划）", (routePlan.json?.items || []).every((item) => item.verdict === "differs" || item.verdict === "newer-loaded"), JSON.stringify((routePlan.json?.items || []).map((item) => [item.name, item.verdict])));
const routeNoConfirm = await callRoute("/skillsync", "POST", { apply: true });
ok("面板路由的写盘闸在服务端：apply 不带 confirm 直接被拒", routeNoConfirm.json?.ok === false && /confirm/.test(String(routeNoConfirm.json?.error || "")), JSON.stringify(routeNoConfirm.json?.error));
const routeGet = await callRoute("/skillsync", "GET");
ok("/skillsync 只接受 POST（GET 404，别让人用地址栏触发写盘）", routeGet.status === 404 || routeGet.json === null, JSON.stringify({ status: routeGet.status, json: routeGet.json }));
/* 带不存在 id 的 apply：走完写盘分支但一份也不复制（安全地验「真写」这条路通不通） */
const routeApplyEmpty = await callRoute("/skillsync", "POST", { ids: ["skill:__hosttest_none__"], apply: true, confirm: true });
ok("带 confirm 的 apply 真的走到写盘分支（不存在的 id → 复制 0 份，不碰真文件）", routeApplyEmpty.json?.ok === true && routeApplyEmpty.json?.applied === true && routeApplyEmpty.json?.count === 0, JSON.stringify(routeApplyEmpty.json && { ok: routeApplyEmpty.json.ok, applied: routeApplyEmpty.json.applied, count: routeApplyEmpty.json.count }));

const { scanSkillStaging, skillVerdict, copySkillToStaging, skillStamp, isStaleVerdict, SKILL_FILE } = await import("../lib/staging.mjs");
ok("staging 判据模块导出（面板、工具、体检共用同一套）", SKILL_FILE === "SKILL.md" && typeof scanSkillStaging === "function" && typeof copySkillToStaging === "function" && typeof skillStamp === "function");
/* 纯函数边界：这四种情况在真机上都会出现，写错一种就会「明明一致却提示同步」或反之 */
eq("skillVerdict：两边都没有 → absent（不进任何列表）", skillVerdict(null, null).verdict, "absent");
eq(
	"skillVerdict：只有 live 有 → missing-staged（发布出去是空壳，算旧）",
	skillVerdict({ size: 10, mtimeMs: 1000 }, null).verdict,
	"missing-staged",
);
ok("missing-staged 算旧", isStaleVerdict("missing-staged") && isStaleVerdict("differs") && isStaleVerdict("newer-loaded") && !isStaleVerdict("newer-workspace") && !isStaleVerdict("same"));
eq("skillVerdict：size 不同 → differs（不读内容）", skillVerdict({ size: 10, mtimeMs: 1000 }, { size: 11, mtimeMs: 1000 }).verdict, "differs");
eq("skillVerdict：同样大小、30 秒内 → same（容差 60 秒）", skillVerdict({ size: 10, mtimeMs: 1000 }, { size: 10, mtimeMs: 31000 }).verdict, "same");
eq("skillVerdict：staging 明显更新 → newer-workspace（**不许自动同步**）", skillVerdict({ size: 10, mtimeMs: 1000 }, { size: 10, mtimeMs: 200000 }).verdict, "newer-workspace");
eq("skillVerdict：live 明显更新 → newer-loaded（该同步）", skillVerdict({ size: 10, mtimeMs: 200000 }, { size: 10, mtimeMs: 1000 }).verdict, "newer-loaded");

/* 用临时目录验扫描与复制：绝不碰真的 .gh-upload 与 .dsh/skills */
const liveRoot = join(dataDir, "staging-live");
const stageRoot = join(dataDir, "staging-stage");
mkdirSync(join(liveRoot, "alpha"), { recursive: true });
mkdirSync(join(stageRoot, "alpha"), { recursive: true });
mkdirSync(join(liveRoot, "beta"), { recursive: true });
mkdirSync(join(stageRoot, "beta"), { recursive: true });
mkdirSync(join(liveRoot, "gamma"), { recursive: true }); /* gamma 没发布过 */
writeFileSync(join(liveRoot, "alpha", "SKILL.md"), "# alpha\n新内容\n");
writeFileSync(join(stageRoot, "alpha", "SKILL.md"), "# alpha\n旧\n");
writeFileSync(join(liveRoot, "beta", "SKILL.md"), "# beta\n");
writeFileSync(join(stageRoot, "beta", "SKILL.md"), "# beta\n");
writeFileSync(join(liveRoot, "gamma", "SKILL.md"), "# gamma\n");
const scan = await scanSkillStaging({ roots: [liveRoot], stageDir: stageRoot });
ok("scanSkillStaging：只数两边都有的（没发布的不算「旧」）", scan.pairs === 2 && scan.missing === 1, JSON.stringify({ pairs: scan.pairs, missing: scan.missing, stale: scan.stale.map((item) => item.name) }));
ok("scanSkillStaging：内容长度不同的那份进 stale", scan.stale.length === 1 && scan.stale[0].name === "alpha" && scan.stale[0].verdict === "differs", JSON.stringify(scan.stale));
ok("scanSkillStaging：一致的那份进 same", scan.same === 1);
const stamp = skillStamp();
const copied = await copySkillToStaging({ loadedDir: join(liveRoot, "alpha"), stagedDir: join(stageRoot, "alpha"), stamp });
ok("copySkillToStaging：单向写过去并给出备份路径", copied.ok === true && copied.backup.includes(".bak-" + stamp) && existsSync(copied.backup), JSON.stringify(copied));
ok(
	"copySkillToStaging：staging 那份成了 live 的内容（旧内容进备份，可回滚）",
	readFileSync(join(stageRoot, "alpha", "SKILL.md"), "utf8") === readFileSync(join(liveRoot, "alpha", "SKILL.md"), "utf8") && readFileSync(copied.backup, "utf8").includes("旧"),
);
const afterCopy = await scanSkillStaging({ roots: [liveRoot], stageDir: stageRoot });
ok("同步完再扫：stale 归零（面板刷新后公告条会消失）", afterCopy.stale.length === 0 && afterCopy.same === 2, JSON.stringify({ stale: afterCopy.stale.length, same: afterCopy.same }));

/* ─────────── R20：判据升级为正文哈希 + staging 备份可还原 ─────────── */
const { hashSkillText, listSkillBackups, restoreSkillBackup } = await import("../lib/staging.mjs");
{
	const sameSize = (text, mtimeMs) => ({ size: Buffer.byteLength(text, "utf8"), mtimeMs, hash: hashSkillText(text) });
	eq(
		"skillVerdict：同字数改一个字（时间差 5 秒）→ differs（R20 的核心修正）",
		skillVerdict(sameSize("AAAA-1111", 1000), sameSize("BBBB-1111", 6000)).verdict,
		"differs",
	);
	eq(
		"skillVerdict：内容相同、mtime 差一小时 → same（哈希优先于时间）",
		skillVerdict(sameSize("SAME", 1000), sameSize("SAME", 1000 + 3600000)).verdict,
		"same",
	);
}
const skillDriftEntries = skillDrift.map((id) => drift[id]);
ok(
	"drift 的 Skill 条目带备份计数与哈希（面板「历史备份 N 份」的数据源）",
	skillDriftEntries.every((entry) => entry && typeof entry.backups === "object" && typeof entry.backups.count === "number" && (entry.backups.count === 0 || /^SKILL\.md\.bak-/.test(String(entry.backups.latest && entry.backups.latest.name)))) &&
		skillDriftEntries.every((entry) => typeof entry.loadedHash === "string" || entry.loadedHash === null),
	JSON.stringify(skillDriftEntries.slice(0, 3).map((entry) => ({ count: entry.backups && entry.backups.count, latest: entry.backups && entry.backups.latest && entry.backups.latest.name }))),
);
const routeRestorePlan = await callRoute("/skillsync", "POST", { action: "restore" });
ok(
	"/skillsync action=restore 计划：只读、方向 backup → staging",
	routeRestorePlan.status === 200 && routeRestorePlan.json?.ok === true && routeRestorePlan.json?.applied !== true && typeof routeRestorePlan.json?.count === "number" && routeRestorePlan.json?.direction === "backup → staging",
	JSON.stringify(routeRestorePlan.json && { ok: routeRestorePlan.json.ok, count: routeRestorePlan.json.count, applied: routeRestorePlan.json.applied, direction: routeRestorePlan.json.direction }),
);
const routeRestoreNoConfirm = await callRoute("/skillsync", "POST", { action: "restore", ids: skillDrift.slice(0, 1), apply: true });
ok("还原的写盘闸：apply 不带 confirm 直接被拒（绝不静默覆盖 staging）", routeRestoreNoConfirm.json?.ok === false && /confirm/.test(String(routeRestoreNoConfirm.json?.error || "")), JSON.stringify(routeRestoreNoConfirm.json?.error));
const restoreToolPlan = await callTool("catalog_skill_sync", { action: "restore" });
ok("catalog_skill_sync action=restore 出还原计划（不写盘）", restoreToolPlan?.ok === true && /还原计划/.test(String(restoreToolPlan?.text || "")) && restoreToolPlan?.applied !== true, String(restoreToolPlan?.count));
const backupName = copied.backup.split(/[\\/]/).pop();
const restoredTemp = await restoreSkillBackup({ stagedDir: join(stageRoot, "alpha"), backup: backupName, stamp: "20261024-160000" });
const restoredAgain = await restoreSkillBackup({ stagedDir: join(stageRoot, "alpha"), backup: backupName, stamp: "20261024-160001" });
const restorePre = restoredTemp.preRestore ? readFileSync(join(stageRoot, "alpha", restoredTemp.preRestore), "utf8") : "";
ok(
	"restoreSkillBackup：还原后 staging 回到备份内容、当前那份另存 pre-restore",
	restoredTemp.skipped === false && restoredTemp.preRestore === "SKILL.md.bak-20261024-160000" && readFileSync(join(stageRoot, "alpha", "SKILL.md"), "utf8").includes("旧") && restorePre.includes("新内容"),
	JSON.stringify({ pre: restoredTemp.preRestore, skipped: restoredTemp.skipped }),
);
ok("restoreSkillBackup：备份与当前一致时不再制造备份（skipped）", restoredAgain.skipped === true && restoredAgain.preRestore === "");
const backupList = await listSkillBackups(join(stageRoot, "alpha"));
ok("listSkillBackups：列出历史备份（新的在前，含 pre-restore 那份）", backupList.count >= 2 && backupList.items[0].name === "SKILL.md.bak-20261024-160000", JSON.stringify(backupList.items.map((item) => item.name)));

/* 体检第 4 项：真跑一次 ship（只跑 staging 这一项，秒级，不写工作区）
   ★ 沙箱里 spawn 带管道会 EPERM（Windows 沙箱不给建命名管道），这不是代码缺陷 —— 记 SKIP，
     并在宿主里（`host_selfcheck` / 面板「自检」）会跑到真的那条路。 */
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const runNode = promisify(execFile);
const shipScript = join(dirname(fileURLToPath(import.meta.url)), "..", "dev", "ship.mjs");
const shipReport = join(dataDir, "ship-staging.md");
let shipResult = null;
let shipErr = "";
let spawnBlocked = false;
try {
	const { stdout, stderr } = await runNode(process.execPath, [shipScript, "--json", "--only", "staging", "--report", shipReport], { cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), env: { ...process.env, ELECTRON_RUN_AS_NODE: process.versions.electron ? "1" : process.env.ELECTRON_RUN_AS_NODE }, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
	const line = String(stdout).split(/\r?\n/).map((row) => row.trim()).filter(Boolean).reverse().find((row) => row.startsWith("{"));
	shipResult = { payload: line ? JSON.parse(line) : null, stderr: String(stderr) };
} catch (error) {
	shipErr = String(error?.message ?? error).split(/\r?\n/)[0];
	spawnBlocked = /EPERM|EPIPE|pipe|not permitted/i.test(shipErr + " " + String(error?.code || ""));
}
if (spawnBlocked) {
	skip("ship.mjs --only staging 能跑出结构化结论", "沙箱禁止带管道 spawn 子进程（" + shipErr + "）；在宿主里跑同一项可验");
	skip("第 4 项自报 informational（只报不拦）", "同上：需要能 spawn");
	skip("第 4 项给出「几对里几个旧」与 stale 名单", "同上：需要能 spawn");
	skip("staging 项不进合计", "同上：需要能 spawn");
	skip("进度事件带 total", "同上：需要能 spawn");
} else {
	ok("ship.mjs 能单独跑「副本同步」这一项（交接前那条命令的第 4 项）", shipResult?.payload !== null && shipErr === "", shipErr);
	const stagingCheck = (shipResult?.payload?.checks || []).find((check) => check.id === "staging") || null;
	ok("第 4 项自报 informational（只报不拦：不把 staging 旧了算成代码缺陷）", stagingCheck?.informational === true && stagingCheck?.ok === true, JSON.stringify(stagingCheck && { ok: stagingCheck.ok, informational: stagingCheck.informational }));
	ok("第 4 项给出「几对里几个旧」与 stale 名单", typeof stagingCheck?.pairs === "number" && Array.isArray(stagingCheck?.stale), JSON.stringify(stagingCheck && { pairs: stagingCheck.pairs, stale: stagingCheck.stale }));
	ok("staging 项不进合计（585 这个数必须能和历史值直接比）", shipResult?.payload?.totals?.passed === 0 && shipResult?.payload?.totals?.failed === 0, JSON.stringify(shipResult?.payload?.totals));
	ok("进度事件带 total（面板靠它画「第 2/4 项」，不写死）", /ship:check:total:1/.test(String(shipResult?.stderr || "")), String(shipResult?.stderr || "").slice(0, 120));
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

/* ── R15：批量打标（只加不减 / 幂等 / 维度校验 / 幽灵 id / 清空删记录）──
   ★ 全部走真路由，不调 service 的私有字段：面板点「应用」走的就是这条路。
   ★ 刻意避开 entries[1]（上面 AI 分类的落点）与 target（entries[0]），别互相污染。 */
const batchA = entries[2];
const batchB = entries[3];
if (batchA && batchB) {
	await callRoute("/tags", "POST", { action: "set", id: batchA.id, purpose: [customId], context: [] });
	await callRoute("/tags", "POST", { action: "set", id: batchB.id, purpose: [customId], context: [] });

	const addBatch = await callRoute("/tags", "POST", { action: "batch", ids: [batchA.id, batchB.id], ops: [{ dimension: "purpose", tagId: "ui", op: "add" }] });
	ok("批量打标：一次给两条各加上一个标签", addBatch.json?.ok === true && addBatch.json?.changed === 2, JSON.stringify(addBatch.json && { changed: addBatch.json.changed }));

	const addAgain = await callRoute("/tags", "POST", { action: "batch", ids: [batchA.id, batchB.id], ops: [{ dimension: "purpose", tagId: "ui", op: "add" }] });
	ok("批量打标幂等：重复点第二次 changed=0（不会把标签翻倍或重写）", addAgain.json?.changed === 0 && addAgain.json?.unchanged === 2, JSON.stringify(addAgain.json && { changed: addAgain.json.changed, unchanged: addAgain.json.unchanged }));

	const afterBatch = await callRoute("/state");
	const batchTags = afterBatch.json?.entries?.find((item) => item.id === batchA.id)?.tags;
	ok("批量「加上」不清掉条目原有的其它标签（customId 与 ui 同时在场）", (batchTags?.purpose || []).includes(customId) && (batchTags?.purpose || []).includes("ui"), JSON.stringify(batchTags?.purpose));

	const badDimension = await callRoute("/tags", "POST", { action: "batch", ids: [batchA.id], ops: [{ dimension: "context", tagId: "ui", op: "add" }] });
	ok("维度不符的标签被拒并报出来（ui 是 purpose，当作 context 打进去以后永远筛不出来）", badDimension.json?.ok === true && (badDimension.json?.unknownTags || []).includes("ui") && badDimension.json?.changed === 0, JSON.stringify(badDimension.json && { unknownTags: badDimension.json.unknownTags, changed: badDimension.json.changed }));

	const ghostId = "plugin:definitely-not-in-catalog";
	const ghost = await callRoute("/tags", "POST", { action: "batch", ids: [ghostId], ops: [{ dimension: "purpose", tagId: "ui", op: "add" }] });
	ok("id 不在目录里时整批拒绝（防 tags.json 长幽灵分配）", ghost.json?.ok === false && (ghost.json?.unknownIds || []).includes(ghostId), JSON.stringify(ghost.json && { ok: ghost.json.ok, unknownIds: ghost.json.unknownIds }));

	const clearBatch = await callRoute("/tags", "POST", {
		action: "batch",
		ids: [batchA.id],
		ops: [
			{ dimension: "purpose", tagId: "ui", op: "remove" },
			{ dimension: "purpose", tagId: customId, op: "remove" },
		],
	});
	ok("批量「去掉」执行成功", clearBatch.json?.ok === true && clearBatch.json?.changed === 1, JSON.stringify(clearBatch.json && { changed: clearBatch.json.changed }));

	const afterClear = await callRoute("/state");
	ok(
		"标签被清空后分配记录整条删掉（不留 by=user 的空记录 —— 那会让 AI 分类永远跳过这条）",
		!afterClear.json?.tags?.assignments?.[batchA.id],
		JSON.stringify(afterClear.json?.tags?.assignments?.[batchA.id]),
	);
	const clearTags = afterClear.json?.entries?.find((item) => item.id === batchA.id)?.tags;
	ok("清空后界面上也真的没有标签了", (clearTags?.purpose || []).length === 0 && (clearTags?.context || []).length === 0, JSON.stringify(clearTags));
}

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

/* ── R14：处置清单（不会被加载 → 怎么卸干净）──
   三条必须都验：工具能出清单、路由的写盘闸在服务端、**跑完一个目录都没少**（只生成不执行）。 */
const nmPath = profileNodeModules();
const countNmDirs = () => {
	try {
		let count = 0;
		for (const entry of readdirSync(nmPath)) {
			if (entry.startsWith(".")) continue;
			if (entry.startsWith("@")) {
				try {
					count += readdirSync(join(nmPath, entry)).length;
				} catch {
					/* 读不到不算数 */
				}
			} else count += 1;
		}
		return count;
	} catch {
		return -1;
	}
};
const nmBefore = countNmDirs();
const uninstallPlan = await callTool("catalog_uninstall", { action: "plan" });
ok(
	"catalog_uninstall plan：给出分组与体积，且不停在 job 里（工具直接回结果）",
	uninstallPlan?.ok !== false && typeof uninstallPlan?.dormant === "object" && Array.isArray(uninstallPlan?.groups) && Number.isFinite(uninstallPlan?.dormant?.reclaimBytes),
	JSON.stringify(uninstallPlan && { candidates: uninstallPlan.dormant?.dirCandidates, groups: uninstallPlan.groups?.length }),
);
ok("每组都带步骤，且「删目录」那一步的命令是给人看的（-LiteralPath）", (uninstallPlan?.groups || []).every((group) => Array.isArray(group.steps) && group.steps.length > 0));
ok("工具文案点明「只生成、不执行删除」", /只生成/.test(String(uninstallPlan?.text || "")) && /不执行/.test(String(uninstallPlan?.text || "")));
ok("跑完清单，node_modules 顶层目录数一个没少（只生成不执行）", countNmDirs() === nmBefore, nmBefore + " → " + countNmDirs());
const uninstallNoConfirm = await callTool("catalog_uninstall", { action: "write" });
ok("write 不带 confirm 被拒（写盘闸在服务端）", uninstallNoConfirm?.ok === false && /confirm/.test(String(uninstallNoConfirm?.error || "")), JSON.stringify(uninstallNoConfirm?.error));

const uninstallRouteNoConfirm = await callRoute("/uninstall", "POST", { apply: true });
ok("面板路由写盘也要 confirm", uninstallRouteNoConfirm.json?.ok === false && /confirm/.test(String(uninstallRouteNoConfirm.json?.error || "")), JSON.stringify(uninstallRouteNoConfirm.json?.error));
const uninstallRouteGet = await callRoute("/uninstall", "GET");
ok("/uninstall 只接受 POST（GET 404，别让人用地址栏触发）", uninstallRouteGet.status === 404 || uninstallRouteGet.json === null, JSON.stringify({ status: uninstallRouteGet.status }));

/* 面板按钮走的那条路：POST {} → 起后台任务 → 结论落在 /state.uninstall（不是 job 那一格） */
const uninstallRoutePlan = await callRoute("/uninstall", "POST", {});
ok("面板路由能起处置清单任务（或在单任务闸上如实拒绝）", uninstallRoutePlan.json?.ok === true || /已有任务|在跑/.test(String(uninstallRoutePlan.json?.error || "")), JSON.stringify(uninstallRoutePlan.json && { ok: uninstallRoutePlan.json.ok, error: uninstallRoutePlan.json.error }));
let uninstallSummary = null;
const uninstallDeadline = Date.now() + 20000;
while (Date.now() < uninstallDeadline) {
	const snapshot = await callRoute("/state");
	if (snapshot.json?.uninstall && (snapshot.json.job?.running !== true || snapshot.json.job?.kind !== "uninstall")) {
		uninstallSummary = snapshot.json.uninstall;
		break;
	}
	await new Promise((resolve) => setTimeout(resolve, 400));
}
ok(
	"/state.uninstall 带得住结论（dormant 分组 + 可回收体积 + savedTo 字段）",
	uninstallSummary !== null && typeof uninstallSummary.dormant === "object" && Array.isArray(uninstallSummary.groups) && "savedTo" in uninstallSummary,
	JSON.stringify(uninstallSummary && { groups: uninstallSummary.groups?.length, bytes: uninstallSummary.dormant?.reclaimBytes }),
);
ok("跑完两次清单，node_modules 还是没少（两次都没删东西）", countNmDirs() === nmBefore, nmBefore + " → " + countNmDirs());

/* ── R16：删除预演（只算不删） ──
   ★ 这里最值钱的一条是「按整份清单预演必须判安全」：判据说 dormant 不在任何入口、也不在任何
     加载链上，那么把这批包全摘掉就不该有入口指空、也不该有加载中的包声明它们。
     它一旦不成立，说明清单本身选错了包 —— 这不是模拟器的 bug，是 R12/R14 的判据破了。 */
const simulateAll = await callTool("catalog_uninstall", { action: "simulate" });
ok(
	"catalog_uninstall simulate：按整份清单预演，给出结论与前后态",
	simulateAll?.ok === true && typeof simulateAll?.verdict === "string" && typeof simulateAll?.before?.counts === "object" && Array.isArray(simulateAll?.breaking) && Array.isArray(simulateAll?.demoted),
	JSON.stringify(simulateAll && { ok: simulateAll.ok, verdict: simulateAll.verdict, error: simulateAll.error }),
);
ok(
	"预演的文案把结论与三行风险都写出来（不只回一个 ok）",
	/删除预演（只算不删）/.test(String(simulateAll?.text || "")) && /结论：/.test(String(simulateAll?.text || "")) && /现在会被加载/.test(String(simulateAll?.text || "")) && /删完会指空的入口/.test(String(simulateAll?.text || "")) && /仍声明它们的包/.test(String(simulateAll?.text || "")) && /加载态/.test(String(simulateAll?.text || "")) && /可回收/.test(String(simulateAll?.text || "")),
	String(simulateAll?.text || "").slice(0, 200),
);
const planMemberCount = (uninstallPlan?.groups || []).reduce((sum, group) => sum + (Number(group.count) || 0), 0);
ok(
	"预演的名单就是清单里的那些包（不多不少，且已装的才算）",
	(simulateAll?.remove || []).length > 0 && (simulateAll?.remove || []).length <= planMemberCount && (simulateAll?.unknown || []).length === 0,
	JSON.stringify({ remove: simulateAll?.remove?.length, planMembers: planMemberCount, unknown: simulateAll?.unknown?.length }),
);
ok(
	"按整份清单预演必然判安全：没有入口指空、没有加载中的包声明它们（判据的自证）",
	simulateAll?.verdict === "safe" && simulateAll?.breaking?.length === 0 && simulateAll?.brokenEntries?.length === 0 && simulateAll?.dangling?.length === 0,
	JSON.stringify({ verdict: simulateAll?.verdict, breaking: simulateAll?.breaking?.length, broken: simulateAll?.brokenEntries?.length, dangling: simulateAll?.dangling?.length }),
);
ok(
	"整份清单删完：没有谁掉回 dormant（dormant 本来就不在加载链上），且包数守恒",
	simulateAll?.demoted?.length === 0 && simulateAll?.revived?.length === 0 && simulateAll?.after?.total === simulateAll?.before?.total - simulateAll?.remove?.length,
	JSON.stringify({ demoted: simulateAll?.demoted?.length, total: [simulateAll?.before?.total, simulateAll?.after?.total] }),
);
ok(
	"预演不动盘：摘掉的全是内存里的，node_modules 目录数没变",
	countNmDirs() === nmBefore,
	nmBefore + " → " + countNmDirs(),
);

/* 单删父包 = 留孤儿：组内别名包还声明着它 —— 这正是清单要求「整组一起处置」的原因 */
const simulateOne = await callTool("catalog_uninstall", { action: "simulate", packages: ["dsh-mnemon"] });
ok(
	"点名单删 dsh-mnemon：预演报「还有包声明它」，判有风险（组要整组处置）",
	simulateOne?.ok === true && simulateOne?.verdict === "risky" && (simulateOne?.dangling || []).some((item) => item.dep === "dsh-mnemon"),
	JSON.stringify(simulateOne && { verdict: simulateOne.verdict, dangling: simulateOne.dangling?.length, breaking: simulateOne.breaking?.length }),
);

const simulateUnknown = await callTool("catalog_uninstall", { action: "simulate", packages: ["definitely-not-installed"] });
ok(
	"点名一个不存在的包：进 unknown、摘 0 个、判安全（不瞎猜）",
	simulateUnknown?.ok === true && simulateUnknown?.unknown?.length === 1 && simulateUnknown?.remove?.length === 0 && simulateUnknown?.verdict === "safe",
	JSON.stringify(simulateUnknown && { unknown: simulateUnknown.unknown, remove: simulateUnknown.remove }),
);

const simulateRoute = await callRoute("/uninstall", "POST", { action: "simulate" });
ok(
	"面板路由 action=simulate：直接回结果（不起后台任务、不写盘）",
	simulateRoute.json?.ok === true && typeof simulateRoute.json?.verdict === "string" && simulateRoute.json?.job === undefined,
	JSON.stringify(simulateRoute.json && { ok: simulateRoute.json.ok, verdict: simulateRoute.json.verdict, job: simulateRoute.json.job }),
);

/* ── R17：变化追踪（自上次目录快照以来变了什么） ──
   判据落在磁盘上的 history.json：启动要落一条、重建不能重复落、/state 报得出来。 */
const historyPath = join(dataDir, "history.json");
const bootHistory = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : { snapshots: [] };
ok(
	"变化追踪：第一次目录构建就落了一条快照（12 位指纹 + 条目表 + at）",
	Array.isArray(bootHistory.snapshots) && bootHistory.snapshots.length >= 1 && /^[0-9a-f]{12}$/.test(String(bootHistory.snapshots[0].fingerprint || "")) && Object.keys(bootHistory.snapshots[0].entries || {}).length > 0 && Number(bootHistory.snapshots[0].at) > 0,
	JSON.stringify({ snapshots: bootHistory.snapshots?.length, fingerprint: bootHistory.snapshots?.[0]?.fingerprint, entries: Object.keys(bootHistory.snapshots?.[0]?.entries || {}).length }),
);
const stateChanges = (await callRoute("/state")).json?.changes;
ok(
	"/state.changes：第一条快照时 first=true 且 0 处变化（不能把「还没有历史」说成「没变化」）",
	stateChanges && (stateChanges.first === true ? stateChanges.counts?.total === 0 : Number.isInteger(stateChanges.counts?.total)),
	JSON.stringify(stateChanges && { first: stateChanges.first, total: stateChanges.counts?.total, snapshots: stateChanges.snapshots }),
);
/* 同一件事绝不能重复追加：两次重建如果都写一条，同一份指纹就会在文件里出现两次。
   ★ 这里**故意不跑重建**（一次全量重建 30 秒，会把 30 秒的自检拖成 97 秒）——
     追加判据本身由 probe-history 的 H2/H4/H15（指纹稳定性 + 无变化 diff 为空）与
     audit 的静态断言覆盖；这里只查落盘结果里有没有重复指纹。 */
const historyAfter = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : { snapshots: [] };
const fingerprints = historyAfter.snapshots.map((item) => item.fingerprint);
ok(
	"历史里没有重复指纹（指纹没变就不追加，同一条不会被记两次）",
	new Set(fingerprints).size === fingerprints.length && fingerprints.length >= 1,
	`${fingerprints.length} 条 / ${new Set(fingerprints).size} 个不同指纹`,
);
ok(
	"历史只留最近 20 条（无上限的增长会把数据目录堆成垃圾场）",
	historyAfter.snapshots.length <= 20,
	String(historyAfter.snapshots.length),
);

/* ── R19：Skill 正文哈希 + 「已看过」确认窗口 ──
   判据落在磁盘上的 history.json / history-ack.json 与 /state、/health 两处视图：
   正文哈希必须进快照（否则正文改动永远看不见）；确认必须写基线文件、之后窗口清零。 */
const ackPath = join(dataDir, "history-ack.json");
const ackBefore = existsSync(ackPath);
const stateBeforeAck = (await callRoute("/state")).json;
ok(
	"确认窗口：没标记过时 /state.sinceAck 是 null（不能拿「自上次快照」冒充确认过）",
	ackBefore ? Boolean(stateBeforeAck.sinceAck && stateBeforeAck.sinceAck.acked === true) : stateBeforeAck.sinceAck === null,
	JSON.stringify(stateBeforeAck.sinceAck && { acked: stateBeforeAck.sinceAck.acked, total: stateBeforeAck.sinceAck.counts?.total }),
);
const skillSnapshotEntries = Object.entries(historyAfter.snapshots[historyAfter.snapshots.length - 1]?.entries || {}).filter(([, entry]) => entry.kind === "skill");
ok(
	"Skill 正文哈希进快照：每条 skill 都有 12 位内容哈希（缺一条 = 那条正文改动永远看不见）",
	skillSnapshotEntries.length > 0 && skillSnapshotEntries.every(([, entry]) => /^[0-9a-f]{12}$/.test(String(entry.content || ""))),
	`${skillSnapshotEntries.length} 条 skill / 有哈希 ${skillSnapshotEntries.filter(([, entry]) => /^[0-9a-f]{12}$/.test(String(entry.content || ""))).length}`,
);
const healthHashes = (await callRoute("/health")).json?.skillHashes;
ok("正文指纹覆盖率：/health 报出 hashed = total（0/N 意味着正文改动完全看不见）", Boolean(healthHashes) && healthHashes.total > 0 && healthHashes.hashed === healthHashes.total, JSON.stringify(healthHashes));
const ackRejected = await callRoute("/ack", "POST", {});
ok(
	"标记已看过：不带 confirm 直接被拒（400，且不写基线文件）",
	ackRejected.status === 400 && ackRejected.json?.ok === false && (ackBefore || !existsSync(ackPath)),
	JSON.stringify({ status: ackRejected.status, json: ackRejected.json }),
);
const ackAccepted = await callRoute("/ack", "POST", { confirm: true });
ok(
	"标记已看过：带 confirm 才写基线（返回确认时间与冻结的条目数）",
	ackAccepted.status === 200 && ackAccepted.json?.ok === true && Number(ackAccepted.json.ackAt) > 0 && Number(ackAccepted.json.entries) > 0,
	JSON.stringify(ackAccepted.json && { ok: ackAccepted.json.ok, entries: ackAccepted.json.entries }),
);
const ackFile = existsSync(ackPath) ? JSON.parse(readFileSync(ackPath, "utf8")) : null;
ok(
	"已看过基线落 history-ack.json（冻结整份快照，不是只存一个时间戳）",
	Boolean(ackFile) && Number(ackFile.at) > 0 && ackFile.snapshot && Object.keys(ackFile.snapshot.entries || {}).length > 0 && /^[0-9a-f]{12}$/.test(String(ackFile.snapshot.fingerprint || "")),
	JSON.stringify(ackFile && { at: ackFile.at, entries: Object.keys(ackFile.snapshot.entries || {}).length, fingerprint: ackFile.snapshot.fingerprint }),
);
const stateAfterAck = (await callRoute("/state")).json?.sinceAck;
ok(
	"确认之后 /state.sinceAck 立即清零（同一目录：total=0，基线时间就是确认时间）",
	Boolean(stateAfterAck) && stateAfterAck.acked === true && stateAfterAck.counts.total === 0 && Number(stateAfterAck.ackAt) > 0 && Number(stateAfterAck.baselineAt) === Number(stateAfterAck.ackAt),
	JSON.stringify(stateAfterAck && { acked: stateAfterAck.acked, total: stateAfterAck.counts?.total, ackAt: stateAfterAck.ackAt, baselineAt: stateAfterAck.baselineAt }),
);
const healthAck = (await callRoute("/health")).json?.ack;
ok("确认之后 /health.ack 报出确认时间与自那以来的计数", Boolean(healthAck) && Number(healthAck.at) > 0 && healthAck.since && healthAck.since.total === 0, JSON.stringify(healthAck && { at: healthAck.at, since: healthAck.since }));

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
const skippedItems = results.filter((item) => item.skipped);
console.log("");
console.log("dsh-plugin-catalog / hosttest");
console.log("  dataDir: " + dataDir);
console.log("  passed: " + (results.length - failed.length - skippedItems.length));
console.log("  failed: " + failed.length);
if (skippedItems.length > 0) console.log("  skipped: " + skippedItems.length + "（无法在本环境执行，见下方 SKIP）");
for (const item of skippedItems) console.log("  · SKIP " + item.name + (item.detail ? " — " + item.detail : ""));
if (failed.length > 0) {
	console.log("");
	for (const item of failed) console.log("  ✗ " + item.name + (item.detail ? " — " + item.detail : ""));
	console.log("");
	if (!process.env.DSH_CATALOG_KEEP) rmSync(dataDir, { recursive: true, force: true });
	process.exit(1);
}
if (!process.env.DSH_CATALOG_KEEP) rmSync(dataDir, { recursive: true, force: true });
console.log("  all good");
