/**
 * dsh-plugin-catalog — 宿主半边。
 *
 * 三件事，其余全在 lib/：
 *   ① 起一个同源 HTTP 前缀路由（面板读状态、刷新、打标签、上传、审核）；
 *   ② 把同一套能力注册成工具（`catalog_*`，普通会话里一句话就能调）；
 *   ③ 启动期兜底：统计缓存没有就**后台**算（不阻塞），每周任务到期就后台跑缺口分析。
 *
 * ⚠️ 失败关闭：任何一个工具注册失败都只记录，不拖垮装个插件树 ——
 *    但如果全部注册失败，面板仍然可用（面板走路由，不走工具）。
 *
 * 面板是**独立客户端插件**：禁用它（或从 `dsh.profile.bundles` 去掉 `dsh-plugin-catalog`）
 * 即恢复官方界面。这条也写在 README 的「自救」一节里。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CatalogService } from "./lib/service.mjs";
import { buildCatalogTools } from "./lib/tools.mjs";
import { buildStamp, hostVersions, profileDir, dataDir as dataDirOf, workspaceRoot } from "./lib/hostinfo.js";
import { loadSettings } from "./lib/settings.mjs";

const PREFIX = "/plugin-catalog";
const MAX_JSON_BODY = 1 * 1024 * 1024;

function service(ctx, key) {
	try {
		if (ctx && typeof ctx.get === "function") {
			const found = ctx.get(key);
			if (found) return found;
		}
	} catch {
		/* 没注入不算错 */
	}
	try {
		return ctx ? ctx[key] : undefined;
	} catch {
		return undefined;
	}
}

function json(res, code, payload) {
	let body;
	try {
		body = JSON.stringify(payload);
	} catch (error) {
		body = JSON.stringify({ ok: false, error: "serialize-failed: " + String(error?.message ?? error) });
		code = 500;
	}
	res.writeHead(code, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(body);
}

function isLoopback(req) {
	const address = (req.socket && req.socket.remoteAddress) || "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * 同源检查。Electron 客户端（`dsh-app://app`）的 fetch 未必来自 127.0.0.1，
 * 所以除了 loopback 还要认 origin / referer / host 一致。
 */
function isTrusted(req) {
	if (isLoopback(req)) return true;
	const origin = String(req.headers.origin || "");
	if (origin === "dsh-app://app") return true;
	const referer = String(req.headers.referer || "");
	if (referer.startsWith("dsh-app://app/")) return true;
	try {
		if (origin) {
			const host = new URL(origin).host;
			const expected = String(req.headers.host || "");
			if (host && expected && host === expected) return true;
		}
	} catch {
		/* ignore */
	}
	return false;
}

async function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_JSON_BODY) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(new Error("invalid json: " + String(error?.message ?? error)));
			}
		});
		req.on("error", reject);
	});
}

export const inject = ["tools", "webServer"];

/**
 * 启动失败要留痕。
 *
 * ★ 真实事故（2026-10-21）：插件 `apply()` 抛错时，Loader 只把 fiber 标成 `failed`，
 *   错误文本只出现在 `plugin_manager set_plugin` 的回包里（`TypeError: Invalid effect`）——
 *   宿主**不写日志文件**（crash-*.log 只在启动中止时才写）。
 *   于是"插件明明装了、面板也渲染了，却没有任何工具和路由"变得极难查。
 *   这里把错误写进 `<dataDir>/logs/apply-error.json`，重启后一眼可见。
 */
async function writeApplyError(dataDir, error) {
	try {
		const { mkdir, writeFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const dir = join(dataDir, "logs");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "apply-error.json"),
			JSON.stringify(
				{ at: new Date().toISOString(), message: String(error?.message ?? error), stack: String(error?.stack || "").split("\n").slice(0, 24) },
				null,
				1,
			),
			"utf8",
		);
	} catch {
		/* 留痕失败不能盖住原始错误 */
	}
}

/**
 * 同步追踪：把 apply 走到哪一步写进 `<dataDir>/logs/apply-trace.log`。
 *
 * 为什么要它：`plugin_manager set_plugin` 的回包**只给错误 message、不给 stack**，
 * 而 "TypeError: Invalid effect" 在 cordis 里只有一个抛出点（`_execute` 里回调返回
 * 「原始值」时），所以「哪一步、哪个回调」只能靠分步留痕定位。
 * 用同步 fs：追踪本身不能引入 await（会改变 effect 的同步阶段）。
 */
function mark(dataDir, step, extra) {
	try {
		const dir = join(dataDir, "logs");
		mkdirSync(dir, { recursive: true });
		appendFileSync(
			join(dir, "apply-trace.log"),
			new Date().toISOString() + " [pid " + process.pid + "] " + step + (extra ? " :: " + extra : "") + "\n",
			"utf8",
		);
	} catch {
		/* 追踪失败不能影响插件 */
	}
}

function stackOf(error) {
	return String(error?.stack || error?.message || error)
		.split("\n")
		.slice(0, 14)
		.join(" ⏎ ");
}

export async function apply(ctx) {
	const traceDir = dataDirOf();
	mark(traceDir, "A:enter", "dataDir=" + traceDir);
	/* ★ 清理必须**同步**注册：cordis 的 `ctx.effect` 只能在 apply 的同步阶段调用。
	   一旦前面有 `await`，再调就抛 `TypeError: Invalid effect` —— 真实踩过：
	   插件整条 fiber failed，面板与 7 个工具全部消失，而宿主一条日志都没有。 */
	let disposeRoute = null;
	const toolDisposers = [];
	try {
		ctx.effect(
		() => () => {
			try {
				disposeRoute?.();
			} catch {
				/* 注销失败无关紧要，进程要走了 */
			}
			for (const fn of toolDisposers) {
				try {
					fn?.();
				} catch {
					/* 同上 */
				}
			}
		},
		"dsh-plugin-catalog: cleanup",
	);
		mark(traceDir, "B:effect-ok");
	} catch (error) {
		mark(traceDir, "X:effect-threw", stackOf(error));
		throw error;
	}

	/* 实时工具 schema：归属判定与自检都要它 —— 取不到就退化为空表（不抛） */
	const toolSchemas = () => {
		const tools = service(ctx, "tools");
		if (!tools || typeof tools.schemas !== "function") return [];
		try {
			const schemas = tools.schemas();
			return Array.isArray(schemas) ? schemas : [];
		} catch {
			return [];
		}
	};

	const catalog = new CatalogService({ ctx, toolSchemas });
	try {
		await catalog.init();
	} catch (error) {
		/* 初始化失败不该让整个插件消失：用默认值继续，面板仍能打开并显示原因 */
		catalog.initError = String(error?.message ?? error);
		await writeApplyError(dataDirOf(), error);
		mark(traceDir, "X:init-threw", stackOf(error));
	}
	mark(traceDir, "C:init-ok", "initError=" + (catalog.initError || "none"));

	/* ───────── 路由 ───────── */
	try {
	disposeRoute = ctx.webServer.register({
		kind: "prefix",
		path: PREFIX,
		handler: async (req, res) => {
			if (!isTrusted(req)) return json(res, 403, { ok: false, error: "trusted origin required" });
			const url = new URL(req.url ?? "/", "http://x");
			const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) || "/" : url.pathname;
			const method = req.method || "GET";

			try {
				if (path === "/state" && method === "GET") {
					/* 打开面板就算一次"每周任务检查"：到期就后台跑，不阻塞这次响应 */
					const tick = catalog.weeklyTick();
					const state = await catalog.state();
					return json(res, 200, { ...state, weeklyTick: tick });
				}

				if (path === "/entry" && method === "GET") {
					const id = url.searchParams.get("id") || "";
					const page = Number(url.searchParams.get("page")) || 1;
					const pageSize = Number(url.searchParams.get("pageSize")) || 20;
					return json(res, 200, catalog.entryDetail(id, { page, pageSize }));
				}

				if (path === "/size" && method === "GET") {
					/* 懒算：只有打开浮窗才问一次，带 5 分钟缓存 */
					return json(res, 200, await catalog.entrySize(url.searchParams.get("id") || ""));
				}

				if (path === "/sizes" && method === "POST") {
					const body = await readJsonBody(req);
					return json(res, 200, await catalog.entrySizes(Array.isArray(body.ids) ? body.ids : []));
				}

				if (path === "/export" && method === "POST") {
					const body = await readJsonBody(req);
					return json(res, 200, await catalog.exportFiltered({ ids: Array.isArray(body.ids) ? body.ids : [], filters: body.filters && typeof body.filters === "object" ? body.filters : {} }));
				}

				if (path === "/job" && method === "GET") return json(res, 200, catalog.jobSnapshot());

				if (path === "/refresh" && method === "POST") {
					const body = await readJsonBody(req);
					const what = String(body.what || "stats");
					if (what === "stats") return json(res, 200, catalog.refreshStatsInBackground());
					/* 体积全量：后台任务量一遍，落 cache/sizes.json（列表显示 / 排序 / 合计都用它） */
					if (what === "sizes") {
						const started = catalog.startJob("sizes", async (progress) => await catalog.computeSizes({ force: false, onProgress: progress }));
						return json(res, 200, started);
					}
					if (what === "catalog") {
						const started = catalog.startJob("catalog", async () => await catalog.rebuildCatalog({ force: true }));
						return json(res, 200, started);
					}
					if (what === "all") {
						const started = catalog.startJob("all", async () => {
							await catalog.rebuildCatalog({ force: true });
							return await catalog.refreshStats({ full: true });
						});
						return json(res, 200, started);
					}
					return json(res, 400, { ok: false, error: "unknown what" });
				}

				if (path === "/tags" && method === "POST") {
					const body = await readJsonBody(req);
					const action = String(body.action || "list");
					if (action === "list") return json(res, 200, { ok: true, tags: catalog.listTags() });
					if (action === "set") return json(res, 200, await catalog.setTags(String(body.id || ""), { purpose: body.purpose, context: body.context }, body.by === "ai" ? "ai" : "user"));
					if (action === "add") return json(res, 200, await catalog.addTag({ label: body.label, gloss: body.gloss, dimension: body.dimension }));
					if (action === "remove") return json(res, 200, await catalog.removeTag(String(body.tagId || "")));
					return json(res, 400, { ok: false, error: "unknown action" });
				}

				if (path === "/source" && method === "POST") {
					const body = await readJsonBody(req);
					return json(res, 200, await catalog.setSource(String(body.id || ""), String(body.source || ""), String(body.note || "")));
				}

				if (path === "/toolowner" && method === "POST") {
					const body = await readJsonBody(req);
					return json(res, 200, await catalog.setToolOwner(String(body.tool || ""), String(body.pkg || "")));
				}

				if (path === "/classify" && method === "POST") {
					const body = await readJsonBody(req);
					const started = catalog.startJob("classify", async () => await catalog.runClassify(Array.isArray(body.ids) ? body.ids : []));
					return json(res, 200, started);
				}

				if (path === "/intro" && method === "POST") {
					const body = await readJsonBody(req);
					if (String(body.action || "generate") === "set") return json(res, 200, await catalog.setIntro(String(body.id || ""), String(body.zh || "")));
					const started = catalog.startJob("intro", async () => await catalog.runIntros(Boolean(body.force)));
					return json(res, 200, started);
				}

				if (path === "/upload" && method === "POST") {
					const body = await readJsonBody(req);
					const action = String(body.action || "plan");
					if (action === "plan") return json(res, 200, await catalog.planUpload());
					if (action === "apply") return json(res, 200, await catalog.applyUpload({ planId: String(body.planId || ""), confirm: body.confirm === true, translate: body.translate !== false, ackRepos: Array.isArray(body.ackRepos) ? body.ackRepos : [] }));
					if (action === "public") return json(res, 200, await catalog.publishPublic({ repo: String(body.repo || ""), dir: String(body.dir || ""), confirm: body.confirm === true }));
					return json(res, 400, { ok: false, error: "unknown action" });
				}

				if (path === "/review" && method === "POST") {
					const body = await readJsonBody(req);
					const target = String(body.target || "gap");
					const name = String(body.name || "");
					const subset = name ? catalog.filteredCatalog(name) : null;
					const kind = target === "security" ? "review-security" : "review-gap";
					const started = catalog.startJob(kind, async () =>
						target === "security" ? await catalog.runSecurity(subset) : target === "both" ? { gap: await catalog.runGap(subset), security: await catalog.runSecurity(subset) } : await catalog.runGap(subset),
					);
					return json(res, 200, started);
				}

				if (path === "/settings" && method === "POST") {
					const body = await readJsonBody(req);
					const settings = await catalog.updateSettings(body && typeof body === "object" ? body : {});
					return json(res, 200, { ok: true, settings, state: await catalog.state() });
				}

				if (path === "/health" && method === "GET") {
					const build = await buildStamp(true);
					const versions = await hostVersions(true);
					return json(res, 200, {
						...await catalog.health(),
						paths: { profileDir: profileDir(), workspace: workspaceRoot(), dataDir: dataDirOf() },
						build,
						versions,
					});
				}

				if (path === "/client-state" && method === "POST") {
					const body = await readJsonBody(req);
					/* 只存结构化摘要（不存任何正文）：面板形态、几何、当前动作、build 号 */
					catalog.clientReport = {
						at: Date.now(),
						build: String(body.build || ""),
						view: String(body.view || ""),
						openId: String(body.openId || ""),
						entries: Number(body.entries) || 0,
						selected: String(body.selected || ""),
						note: String(body.note || "").slice(0, 200),
					};
					return json(res, 200, { ok: true });
				}

				return json(res, 404, { ok: false, error: "unknown path: " + path });
			} catch (error) {
				return json(res, 500, { ok: false, error: String(error?.message ?? error) });
			}
		},
	});
		mark(traceDir, "D:route-ok");
	} catch (error) {
		mark(traceDir, "X:route-threw", stackOf(error));
		throw error;
	}

	/* ───────── 工具（同一套能力） ───────── */
	const tools = service(ctx, "tools");
	const failures = [];
	if (tools && typeof tools.register === "function") {
		for (const definition of buildCatalogTools({ service: catalog })) {
			try {
				toolDisposers.push(tools.register(definition));
			} catch (error) {
				failures.push({ tool: definition.name, error: String(error?.message ?? error) });
			}
		}
	}
	mark(traceDir, "E:tools-ok", "registered=" + toolDisposers.length + " failures=" + JSON.stringify(failures));

	/* 启动兜底：**同一个后台任务里**依次补齐目录快照与统计。
	   ⚠️ 必须合成一个任务：`startJob` 同一时刻只允许一个（防止两个全量扫描互相踩），
	   分成两次调用的话第二个会被"已有任务在跑"挡掉，于是目录永远建不起来。 */
	const needCatalog = Boolean(catalog.catalogStale || !catalog.catalog);
	const needStats = !catalog.aggregate;
	if (needCatalog || needStats) {
		mark(traceDir, "F:job-start", "needCatalog=" + needCatalog + " needStats=" + needStats);
		catalog.startJob("startup", async () => {
			const done = { catalog: false, stats: false };
			try {
				if (needCatalog) {
					await catalog.rebuildCatalog({ force: true });
					done.catalog = true;
					mark(traceDir, "G:job-catalog-done");
				}
				if (needStats) {
					await catalog.refreshStats({});
					done.stats = true;
					mark(traceDir, "G:job-stats-done");
				}
			} catch (error) {
				mark(traceDir, "X:job-threw", stackOf(error));
				throw error;
			}
			return done;
		});
	} else if (catalog.attribNeedsRebuild) {
		/* 归属索引缺了：顺手后台补一份（读 20MB 源码约 3 秒） */
		mark(traceDir, "F:job-attrib");
		catalog.startJob("attrib", async () => {
			try {
				return await catalog.rebuildAttribution();
			} catch (error) {
				mark(traceDir, "X:attrib-threw", stackOf(error));
				throw error;
			}
		});
	}

	catalog.startup = { tools: toolDisposers.length, failures, initError: catalog.initError || "", at: Date.now() };
	catalog.toolFailures = failures;
	mark(traceDir, "H:apply-return", "tools=" + toolDisposers.length);
	/* ★★ 绝对不能 return 值（这是本插件最贵的一个坑，比 effect 时序更隐蔽）。
	   cordis 的 `Fiber._execute()` 把 apply 的返回值当成 **effect disposer** 收：
	     safeCollect = (dispose) => {
	       if (typeof dispose === "function") runner.collect(dispose);
	       else if (!isNullable(dispose)) throw new TypeError("Invalid effect");
	     };
	     ...
	     else if ("then" in effect) return effect.then(safeCollect);   // ← async apply 走这里
	   于是 `apply` 只要 async，整段代码**全部成功**（工具注册了、路由挂了、后台任务也起来了），
	   但 promise 一 resolve 成 `{ catalog }`，safeCollect 立刻抛 `TypeError: Invalid effect`
	   → `_reload` 的 catch 把 fiber 标成 INACTIVE → **已注册的工具与路由被整体回滚**。
	   症状：apply 跑完了却"did not activate"，工具全无、路由 404、宿主只写 console 不写文件。
	   同步 apply 返回普通对象不会抛（那条分支不发 safeCollect），**只有 async apply 会中招**。
	   要暴露服务请用 ctx，不要用返回值。 */
	return;
}

export { CatalogService };
