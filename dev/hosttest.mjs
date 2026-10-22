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

import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

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
eq("注册了 9 个工具", registeredTools.length, 9);
const toolNames = registeredTools.map((tool) => tool.name).sort();
eq("工具名齐全", toolNames, ["catalog_classify", "catalog_export", "catalog_health", "catalog_list", "catalog_publish", "catalog_review", "catalog_skill_sync", "catalog_stats", "catalog_tag"]);
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
	"/preflight dry=true 只回「会跑什么」，不起子进程",
	preflightDry.status === 200 && preflightDry.json?.ok === true && preflightDry.json?.dry === true && Array.isArray(preflightDry.json?.checks) && preflightDry.json.checks.length === 3,
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
