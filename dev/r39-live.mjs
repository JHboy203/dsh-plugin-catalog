/**
 * dev/r39-live.mjs — R39 真机只读核验（换会话后跑一次，≈1 秒）。
 *
 * 为什么单独一条：R39 的三样东西**在磁盘上对、在运行中的宿主里不对**是最容易发生的事 ——
 *   · `toolHints` 只该随**详情页**下发，若它漏回 `/state`，每次 20 秒轮询会多背 ~40 KB；
 *   · 单条中文简介（`/intro action=ensure`）若路由没生效，详情页那个「生成中文简介」会静默失败；
 *   · 会话默认 5 条是**服务端默认值**，前端兜底只是保险 —— 服务端没改就等于没改。
 * 三条都只读，端口用 `--base` 传（每次重启都变）。**不发 confirm、不调模型、不写任何文件。**
 *
 * 用法：`node dev/r39-live.mjs --base http://127.0.0.1:<GUI端口> [--json]`
 * 退出码 0 = 全过；1 = 有失败项。
 */

import { request } from "node:http";
import { readFileSync } from "node:fs";

/* 版本断言从**磁盘的 package.json** 取，不写死 —— 每次提版本都要手改探针，
   改漏了就会在升级当天报一条假红（R40 提 0.40.0 时正是这条先红）。 */
const diskVersion = (() => {
	try {
		return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "";
	} catch {
		return "";
	}
})();

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? String(args[baseIndex + 1] || "").replace(/\/$/, "") : "";
if (!base) {
	console.error("用法：node dev/r39-live.mjs --base http://127.0.0.1:<GUI端口> [--json]");
	process.exit(2);
}

const API = "/plugin-catalog";
const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

/** 用 node:http 取原始字节（fetch 会自动解压，量到的永远是解压后的长度）。 */
function httpJson(method, path, body, extraHeaders = {}) {
	return new Promise((resolve, reject) => {
		const url = new URL(base + API + path);
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method,
				headers: {
					...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
					...extraHeaders,
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks);
					let json = null;
					try {
						json = JSON.parse(raw.toString("utf8"));
					} catch {
						json = null;
					}
					resolve({ status: res.statusCode, bytes: raw.length, headers: res.headers, json });
				});
			},
		);
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

const stateGzip = await httpJson("GET", "/state", undefined, { "accept-encoding": "gzip" }).catch((error) => ({ error: String(error && error.message) || String(error) }));
const statePlain = await httpJson("GET", "/state", undefined, { "accept-encoding": "identity" }).catch(() => null);
const state = (statePlain && statePlain.json) || (stateGzip && stateGzip.json) || null;

ok("L1 /state 返回 200 且有 entries", Boolean(statePlain && statePlain.status === 200 && state && Array.isArray(state.entries) && state.entries.length > 0), statePlain ? "status " + statePlain.status : "请求失败");
ok("L2 构建戳与运行中版本一致（磁盘 " + (diskVersion || "?") + "）", Boolean(state && state.build && diskVersion !== "" && String(state.build.version || "") === diskVersion && state.build.stale !== true), state && state.build ? JSON.stringify(state.build) : "no build");

/* ── 体积预算：toolHints 不许漏回 /state ── */
const entries = (state && state.entries) || [];
ok("L3 /state 的条目**不带** toolHints（纯展示数据只在详情页下发）", entries.length > 0 && entries.every((entry) => entry.toolHints === undefined), entries.filter((entry) => entry.toolHints !== undefined).length + " 条带了");
ok("L4 /state 的原始字节在预算内（≤ 380 KB；R39 收口时实测 345.8 KB，优化前 470 KB）", Boolean(statePlain && statePlain.bytes > 0 && statePlain.bytes <= 380 * 1024), statePlain ? statePlain.bytes + " B" : "量不到");
ok(
	"L5 gzip 后 ≤ 原始的 60%（R31c 的传输预算仍然成立）",
	Boolean(stateGzip && stateGzip.status === 200 && statePlain && stateGzip.bytes > 0 && statePlain.bytes > 0 && stateGzip.bytes <= statePlain.bytes * 0.6),
	stateGzip && statePlain ? stateGzip.bytes + " / " + statePlain.bytes : "量不到",
);

/* ── 设置默认值：会话每页 5 条 ── */
ok("L6 服务端默认会话每页 5 条，且选项里含 5", Boolean(state && state.settings && Number(state.settings.sessionsPageSize) === 5 && Array.isArray(state.settings.pageSizes) && state.settings.pageSizes.includes(5)), state && state.settings ? "sessionsPageSize=" + state.settings.sessionsPageSize + " pageSizes=" + JSON.stringify(state.settings.pageSizes) : "no settings");

/* ── 中文简介的落盘与下发 ── */
const intros = state && state.intros ? state.intros : null;
ok("L7 /state.intros 报得出「生成过几条 / 工具说明几条」（新字段形状）", Boolean(intros && typeof intros.count === "number"), intros ? JSON.stringify(intros) : "no intros");
const withZh = entries.filter((entry) => typeof entry.descriptionZh === "string" && entry.descriptionZh.trim() !== "");
ok("L8 已有条目带中文简介（说明 intros.json 真的被读进来了，不是只写不读）", withZh.length > 0, withZh.length + " / " + entries.length);

/* ── 详情页的 tools[].hint 与 toolHints ── */
const sample = entries.find((entry) => entry.kind === "plugin" && Array.isArray(entry.toolNames) && entry.toolNames.length > 0) || entries[0];
const detailRes = sample ? await httpJson("GET", "/entry?id=" + encodeURIComponent(sample.id) + "&page=1&pageSize=5").catch(() => null) : null;
const detail = detailRes && detailRes.json;
ok("L9 /entry 返回 200 与详情", Boolean(detailRes && detailRes.status === 200 && detail && detail.ok === true), detailRes ? "status " + detailRes.status : "请求失败");
ok("L10 /entry 的每个工具都带中文说明（hint 字段；详情页表格与悬停都靠它）", Boolean(detail && Array.isArray(detail.tools) && detail.tools.length > 0 && detail.tools.every((tool) => typeof tool.hint === "string" && tool.hint.length > 0)), detail && detail.tools ? detail.tools.map((tool) => tool.name + ":" + (tool.hint ? "有" : "空")).join(" ") : "no tools");
ok("L11 /entry 另给 toolHints 映射（与服务端 intros 同源）", Boolean(detail && detail.toolHints && typeof detail.toolHints === "object"), detail && detail.toolHints ? Object.keys(detail.toolHints).length + " 条" : "缺");

/* ── 单条中文简介路由（只读探测：不存在的 id 必须早退，不调模型） ── */
const ensureMiss = await httpJson("POST", "/intro", { action: "ensure", id: "__r39_probe_nonexistent__" }).catch(() => null);
const miss = ensureMiss && ensureMiss.json;
ok("L12 /intro action=ensure 已注册（未知 id 直接说「目录里没有这条条目」，不调模型）", Boolean(ensureMiss && ensureMiss.status === 200 && miss && miss.ok === false && /找不到|没有这条条目/.test(String(miss.error || ""))), miss ? JSON.stringify(miss).slice(0, 160) : "无返回");

/* ── 面板其它形状没被这轮改动带坏 ── */
ok("L13 /state 仍有 totals / mcp / composition / runtime 四个块（R30/R22/R35 的位置没被挤掉）", Boolean(state && state.totals && state.mcp && state.composition && state.runtime), state ? [Boolean(state.totals), Boolean(state.mcp), Boolean(state.composition), Boolean(state.runtime)].join(",") : "no state");

const failed = results.filter((item) => !item.pass);
if (args.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nr39-live: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
