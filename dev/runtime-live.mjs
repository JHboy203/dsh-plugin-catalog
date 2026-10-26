/**
 * dev/runtime-live.mjs — **运行期真相**的真机取证入口（只读，R36）。
 *
 * 为什么要有它（R35 的教训）：声明层说"会加载"不等于 Loader 里真在跑。
 * 面板与 `catalog_runtime` 都能回答，但排查时人往往没有会话可用、或不想开面板 ——
 * 这条命令直接打 `GET /plugin-catalog/runtime`，一条给出：
 *   · Loader 计数（active / failed / pending / 停用 / 没有 fiber）；
 *   · 三类问题（fiberPhase=failed / 声明会加载但 Loader 里没有 / 声明与运行时不一致）；
 *   · bundle 健康（`listBundles()` 的 missing / error，以及"可选未装"的条数）。
 *
 * ★ 用 `node:http` 而不是全局 `fetch`（项目教训）：undici keep-alive 在 `process.exit()` 会撞 libuv 断言；
 *   本机还有 undici 流断开打死宿主的先例。
 * ★ 只读：只发 GET；不调 `/action/*`，不写任何文件。
 *
 * 用法：
 *   node dev/runtime-live.mjs --base http://127.0.0.1:<GUI端口>
 *   node dev/runtime-live.mjs --base ... --json
 *   node dev/runtime-live.mjs --base ... --expect-clean   # 有任何问题就退出码 1
 * 退出码：0 = 读到了运行期（且 --expect-clean 时没有问题）；1 = 读不到 / 有问题 / 请求失败。
 */

import http from "node:http";

function arg(name, fallback = "") {
	const index = process.argv.indexOf("--" + name);
	if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
	const prefix = "--" + name + "=";
	const inline = process.argv.find((item) => item.startsWith(prefix));
	return inline ? inline.slice(prefix.length) : fallback;
}

const asJson = process.argv.includes("--json");
const expectClean = process.argv.includes("--expect-clean");
const base = String(arg("base", process.env.DSH_WEB_URL || "")).replace(/\/+$/, "");

if (!base) {
	console.error("缺 --base（或在环境里给 DSH_WEB_URL）。每次重启 GUI 端口都会变，所以不写死。");
	process.exit(2);
}

function getJson(path) {
	return new Promise((resolve) => {
		const request = http.get(base + "/plugin-catalog" + path, { headers: { accept: "application/json" } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk) => (body += chunk));
			response.on("end", () => {
				try {
					resolve({ status: response.statusCode, json: JSON.parse(body || "{}") });
				} catch {
					resolve({ status: response.statusCode, json: null, body: body.slice(0, 200) });
				}
			});
		});
		request.on("error", (error) => resolve({ status: 0, json: null, error: String(error?.message ?? error) }));
		request.setTimeout(8000, () => request.destroy(new Error("timeout")));
	});
}

const result = await getJson("/runtime?fresh=1");
if (!result.json || result.status !== 200) {
	console.error("runtime-live: 读不到 /runtime（HTTP " + result.status + "）" + (result.error ? "：" + result.error : ""));
	console.error("排查：① GUI 端口对不对（重启后会变）；② 插件宿主半边是否 active（/plugin-catalog/health）");
	process.exit(1);
}
const runtime = result.json;
const counts = runtime.counts || {};
const issues = runtime.issues || {};
const bundles = runtime.bundles || null;
const clean = runtime.available === true && (issues.total || 0) === 0 && (bundles?.problems || []).length === 0;

if (asJson) {
	console.log(JSON.stringify({ available: runtime.available, counts, issues, bundles, clean }, null, 1));
} else {
	console.log("");
	console.log("runtime-live");
	console.log("  " + String(runtime.line || "").slice(0, 240));
	console.log("");
	console.log("  Loader      : " + (counts.total || 0) + " 条（active " + (counts.active || 0) + " / failed " + (counts.failed || 0) + " / 等待 " + (counts.pending || 0) + " / 停用 " + (counts.disabled || 0) + " / 无 fiber " + (counts.nullPhase || 0) + "）");
	console.log("  问题        : " + (issues.total || 0) + " 处（failed " + (issues.failed || 0) + " / declared-absent " + (issues.absent || 0) + " / mismatch " + (issues.mismatch || 0) + "）");
	for (const name of issues.names?.failed || []) console.log("    x failed        : " + name);
	for (const name of issues.names?.absent || []) console.log("    ! not-in-loader : " + name);
	if (bundles) {
		console.log("  bundle      : " + bundles.declared + " 条（missing " + bundles.missing + " / optional-missing " + (bundles.optionalMissing || 0) + " / problems " + ((bundles.problems || []).length) + "）");
		for (const problem of bundles.problems || []) console.log("    x " + problem.kind + " : " + problem.name);
	}
	if (runtime.available !== true) {
		console.log("");
		console.log("  ⚠️ 读不到运行期：" + (runtime.reason || "未知") + " —— 这时**不能**拿声明层 loadState 当运行结论");
	}
	console.log("");
}

if (runtime.available !== true) process.exit(1);
if (expectClean && !clean) process.exit(1);
