/**
 * dev/r40-live.mjs — R40 真机只读核验（换会话后跑一次，≈2 秒）。
 *
 * 为什么单独一条：这一轮新增的 `/repo` 是**唯一会联网**的面板接口，它有三种必须分清的失败：
 *   · 条目没有远端仓 → `reason:"no-repo"`（不是"0 星"）
 *   · 不是 GitHub 仓   → `reason:"not-github"`
 *   · 读不到（没登录 / 网络 / 仓不存在）→ `reason:"repo-unreachable"`
 * 把三者混成一句"暂无数据"，用户就会以为"我的仓没人关注"。
 * 另外两条同样只该在真机上验：**缓存**（10 分钟内第二次必须是 cached）与 **不塞进 /state**。
 *
 * 全程只读：只发 GET / 一个 POST（/intro 的未知 id 早退，不会调模型）。
 * 不写盘、不发 confirm、不改设置。
 *
 * 用法：`node dev/r40-live.mjs --base http://127.0.0.1:<GUI端口> [--json]`
 * 退出码 0 = 全过；1 = 有失败项；2 = 缺 --base。
 */

import { request } from "node:http";

const args = process.argv.slice(2);
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? String(args[baseIndex + 1] || "").replace(/\/$/, "") : "";
if (!base) {
	console.error("用法：node dev/r40-live.mjs --base http://127.0.0.1:<GUI端口> [--json]");
	process.exit(2);
}

const API = "/plugin-catalog";
const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

function httpJson(method, path, body) {
	return new Promise((resolve, reject) => {
		const url = new URL(base + API + path);
		const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
		const req = request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname + url.search,
				method,
				headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
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
					resolve({ status: res.statusCode, bytes: raw.length, json });
				});
			},
		);
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

const stateRes = await httpJson("GET", "/state").catch((error) => ({ error: String((error && error.message) || error) }));
const state = stateRes && stateRes.json;
ok("P1 /state 返回 200 且有 entries", Boolean(stateRes && stateRes.status === 200 && state && Array.isArray(state.entries) && state.entries.length > 0), stateRes ? "status " + stateRes.status : "请求失败");
const entries = (state && state.entries) || [];

/* ── ① 不塞进轮询：/state 里不许出现统计块 ── */
ok(
	"P2 /state 的条目**不带** GitHub 统计（只在打开详情页时按需拉，20 秒轮询不该背它）",
	entries.length > 0 && entries.every((entry) => entry.repoStats === undefined && entry.stars === undefined),
	entries.filter((entry) => entry.repoStats !== undefined || entry.stars !== undefined).length + " 条带了",
);
ok("P3 条目带 repoUrl（客户端据此决定去问 /repo；没有它是那种「点了没反应」）", entries.some((entry) => typeof entry.repoUrl === "string" && entry.repoUrl !== ""), entries.filter((entry) => entry.repoUrl).length + " / " + entries.length);

/* ── ② /repo 的正路：真的读到 GitHub ── */
const githubEntry = entries.find((entry) => /github\.com/.test(String(entry.repoUrl || "")));
const repoRes = githubEntry ? await httpJson("GET", "/repo?id=" + encodeURIComponent(githubEntry.id)).catch(() => null) : null;
const repo = repoRes && repoRes.json;
if (githubEntry) {
	ok("P4 /repo 对带 GitHub 仓的条目返回 200 且 ok=true", Boolean(repoRes && repoRes.status === 200 && repo && repo.ok === true), repo ? JSON.stringify(repo).slice(0, 200) : "无返回");
	ok(
		"P5 /repo 给得出 stars / forks / watchers / license（形状对，而不是一串 undefined）",
		Boolean(repo && repo.stats && typeof repo.stats.stars === "number" && typeof repo.stats.forks === "number" && typeof repo.stats.watchers === "number" && typeof repo.stats.license === "string"),
		repo && repo.stats ? JSON.stringify({ stars: repo.stats.stars, forks: repo.stats.forks, watchers: repo.stats.watchers, license: repo.stats.license }) : "no stats",
	);
	ok(
		"P6 克隆 / 浏览要么有数字，要么明说没权限（trafficDenied=true）—— 不许静默变成 0",
		Boolean(repo && (repo.stats.trafficDenied === true || (repo.stats.clones && typeof repo.stats.clones.count === "number"))),
		repo && repo.stats ? JSON.stringify({ trafficDenied: repo.stats.trafficDenied, clones: repo.stats.clones, trafficError: repo.stats.trafficError }) : "no stats",
	);
	const second = await httpJson("GET", "/repo?id=" + encodeURIComponent(githubEntry.id)).catch(() => null);
	ok("P7 10 分钟内第二次必命中缓存（cached:true，不带网络往返）", Boolean(second && second.json && second.json.cached === true && typeof second.json.ageMs === "number"), second && second.json ? "cached=" + second.json.cached + " ageMs=" + second.json.ageMs : "无返回");
	const forced = await httpJson("GET", "/repo?id=" + encodeURIComponent(githubEntry.id) + "&refresh=1").catch(() => null);
	ok("P8 refresh=1 强制重取（返回 cached:false；但仍是同一条仓）", Boolean(forced && forced.json && forced.json.cached === false && forced.json.repo && forced.json.repo.name), forced && forced.json ? "cached=" + forced.json.cached : "无返回");
} else {
	ok("P4 /repo 对带 GitHub 仓的条目返回 200", false, "这台机器没有带 github.com 仓库地址的条目");
}

/* ── ③ /repo 的三种「没有数字」必须分开说 ── */
const noRepoEntry = entries.find((entry) => !entry.repoUrl);
if (noRepoEntry) {
	const noRepo = await httpJson("GET", "/repo?id=" + encodeURIComponent(noRepoEntry.id)).catch(() => null);
	ok("P9 没有远端仓 → reason=no-repo（不是 0 星）", Boolean(noRepo && noRepo.json && noRepo.json.ok === false && noRepo.json.reason === "no-repo"), noRepo && noRepo.json ? JSON.stringify(noRepo.json).slice(0, 160) : "无返回");
} else {
	ok("P9 没有远端仓 → reason=no-repo", true, "这台机器每个条目都写了 repoUrl（跳过）");
}
const unknown = await httpJson("GET", "/repo?id=" + encodeURIComponent("plugin:__r40_probe_nonexistent__")).catch(() => null);
ok("P10 未知 id → error=unknown-id（不静默返回空统计）", Boolean(unknown && unknown.json && unknown.json.ok === false && unknown.json.error === "unknown-id"), unknown && unknown.json ? JSON.stringify(unknown.json).slice(0, 160) : "无返回");

/* ── ④ 这一轮没动的东西还在 ── */
ok("P11 /size 仍在（体积从卡片收进详情页，但接口没动）", Boolean(entries[0] && (await httpJson("GET", "/size?id=" + encodeURIComponent(entries[0].id)).catch(() => null))?.status === 200));
ok("P12 详情页仍是 /entry（简介 / 工具中文说明 / 会话分页都靠它）", Boolean(entries[0] && (await httpJson("GET", "/entry?id=" + encodeURIComponent(entries[0].id) + "&page=1&pageSize=5").catch(() => null))?.json?.ok === true));

const failed = results.filter((item) => !item.pass);
if (args.includes("--json")) {
	console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 1));
} else {
	for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
	console.log(`\nr40-live: passed ${results.length - failed.length} / failed ${failed.length}`);
}
if (failed.length > 0) process.exit(1);
