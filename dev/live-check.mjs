/**
 * live-check.mjs — 对**运行中的面板**做一次只读体检（R21）。
 *
 * 为什么要有它：每轮收尾都要打一次 `/health` 与 `/state` 真机核验
 * （R20/R21 各写了一份 `.cache/verify-r*.mjs`，用完就删）。这里把同一套动作固化：
 *   · 版本一致性：`health.loaded.version` 必须等于磁盘（`build.version`）且 `stale:false`；
 *   · 时间线：`/state.timeline` 有 total / items（没有窗口时是空数组）；
 *   · 副本：drift 里的 Skill 条目带 hash 与 backups（R20 的数据源）；
 *   · 还原闸门：`/skillsync {action:"restore"}` 只出计划；不带 `confirm` 的 apply 必须被拒
 *     （这条请求本身不写盘 —— 服务端在 confirm 闸之前不会碰文件）；
 *   · R22 配置层：`/health.composition` 有结论与一行摘要，`/state.composition` 的三组计数守恒、
 *     清单每一条都带 file + line（面板浮层读的就是它）。
 *
 * 用法（必须走宿主，普通 node 也能跑；端口每次重启都会变）：
 *   host_selfcheck script=dev/live-check.mjs args=["--base","http://127.0.0.1:<GUI端口>"]
 *   或设环境变量 DSH_CATALOG_LIVE_BASE。
 * 任何一项不通过退出码 1；只发 GET 与两条只读/被拒的 POST，不写任何文件。
 */

const args = process.argv.slice(2);
const baseArg = args.indexOf("--base") >= 0 ? args[args.indexOf("--base") + 1] : "";
const base = String(baseArg || process.env.DSH_CATALOG_LIVE_BASE || "").replace(/\/+$/, "");
if (!base) {
	console.error("live-check: 需要 --base http://127.0.0.1:<端口> 或 DSH_CATALOG_LIVE_BASE");
	process.exit(2);
}

const origin = base;
const host = (() => {
	try {
		return new URL(base).host;
	} catch {
		return "";
	}
})();
const headers = { origin, host, "content-type": "application/json" };

const results = [];
function ok(name, condition, detail = "") {
	results.push({ name, pass: Boolean(condition), detail });
}

async function getJson(path) {
	const response = await fetch(base + "/plugin-catalog" + path, { headers });
	let json = null;
	try {
		json = await response.json();
	} catch {
		json = null;
	}
	return { status: response.status, json };
}

async function postJson(path, body) {
	const response = await fetch(base + "/plugin-catalog" + path, { method: "POST", headers, body: JSON.stringify(body) });
	let json = null;
	try {
		json = await response.json();
	} catch {
		json = null;
	}
	return { status: response.status, json };
}

const health = await getJson("/health");
ok("health: 200 + ok", health.status === 200 && health.json?.ok === true, `status=${health.status}`);
const loaded = health.json?.loaded || null;
const build = health.json?.build || null;
ok(
	"running version matches disk (loaded.stale === false)",
	Boolean(loaded) && loaded.stale === false && String(loaded.version || "") === String(build?.version || ""),
	JSON.stringify({ loaded: loaded && loaded.version, disk: build && build.version, stale: loaded && loaded.stale }),
);
ok("health: tools registered + catalog built", Number(health.json?.toolsRegistered) >= 10 && Number(health.json?.catalog?.plugins) > 0, JSON.stringify({ tools: health.json?.toolsRegistered, plugins: health.json?.catalog?.plugins }));
ok("health: timeline summary present (total / windows)", health.json?.timeline && Number(health.json.timeline.total) >= 1 && Number.isInteger(health.json.timeline.windows), JSON.stringify(health.json?.timeline));
/* R22：配置层在运行中的宿主要能拿到结论（不是只有磁盘代码里有） */
ok(
	"health: composition summary (verdict + line + counts)",
	Boolean(health.json?.composition) &&
		["ok", "warn", "bad"].includes(health.json.composition.verdict) &&
		typeof health.json.composition.line === "string" &&
		Number(health.json.composition.entries) > 0,
	JSON.stringify({ verdict: health.json?.composition?.verdict, entries: health.json?.composition?.entries, line: String(health.json?.composition?.line || "").slice(0, 80) }),
);

const state = await getJson("/state");
ok("state: 200 + build.stale false", state.status === 200 && state.json?.build?.stale === false, `status=${state.status}`);
const timeline = state.json?.timeline || {};
ok("state.timeline: total + items array", Number(timeline.total) >= 1 && Array.isArray(timeline.items), JSON.stringify({ total: timeline.total, items: Array.isArray(timeline.items) && timeline.items.length }));
ok(
	"state.timeline rows: at + counts + category arrays",
	(timeline.items || []).every((row) => Number(row.at) > 0 && row.counts && typeof row.counts.total === "number" && Array.isArray(row.edited)),
	String((timeline.items || []).length + " rows"),
);
/* R23：配置层（声明层）也进变化计数 —— 只有条目信号不够，改 disabled / 加 bundle 时条目一个都不变 */
const liveChanges = state.json?.changes || null;
ok(
	"state.changes: composition bucket present (R23; null before the second snapshot)",
	liveChanges === null || (Number.isInteger(liveChanges.counts?.composition) && liveChanges.counts.composition >= 0),
	JSON.stringify(liveChanges && { total: liveChanges.counts?.total, composition: liveChanges.counts?.composition }),
);
/* R22 /state.composition：紧凑视图（计数守恒 + 清单带来源），面板浮层读的就是它 */
const composition = state.json?.composition || null;
ok(
	"state.composition: verdict + files + counts conserve + listed rows carry file/line",
	Boolean(composition) &&
		Number(composition.at) > 0 &&
		Array.isArray(composition.files) &&
		composition.files.length > 0 &&
		(() => {
			const counts = composition.counts || {};
			const sum = (object) => Object.values(object || {}).reduce((total, n) => total + (Number(n) || 0), 0);
			return sum(counts.byKind) === counts.effective && sum(counts.byResolution) === counts.effective && sum(counts.byState) === counts.effective;
		})() &&
		[...(composition.missing || []), ...(composition.conditional || []), ...(composition.disabled || [])].every((row) => typeof row.file === "string" && row.file !== "" && Number(row.line) > 0),
	JSON.stringify({ verdict: composition?.verdict, files: composition?.files?.length, effective: composition?.counts?.effective, missing: (composition?.missing || []).length }),
);
const drift = state.json?.drift || {};
const stagedSkills = Object.entries(drift).filter(([, entry]) => entry && entry.staged === true);
ok(
	"drift skill entries carry hash + backups (R20 data source)",
	stagedSkills.length === 0 || stagedSkills.every(([, entry]) => (typeof entry.loadedHash === "string" || entry.loadedHash === null) && entry.backups && typeof entry.backups.count === "number"),
	`${stagedSkills.length} staged skills`,
);

const restorePlan = await postJson("/skillsync", { action: "restore" });
ok(
	"restore plan: read-only, direction backup → staging",
	restorePlan.status === 200 && restorePlan.json?.ok === true && restorePlan.json?.applied !== true && typeof restorePlan.json?.count === "number" && restorePlan.json?.direction === "backup → staging",
	JSON.stringify(restorePlan.json && { ok: restorePlan.json.ok, count: restorePlan.json.count, applied: restorePlan.json.applied, direction: restorePlan.json.direction }),
);
const guarded = await postJson("/skillsync", { action: "restore", ids: stagedSkills.slice(0, 1).map(([id]) => id), apply: true });
ok(
	"restore write gate: apply without confirm is rejected (nothing written)",
	guarded.status === 200 && guarded.json?.ok === false && /confirm/.test(String(guarded.json?.error || "")),
	JSON.stringify(guarded.json && { ok: guarded.json.ok, error: guarded.json.error }),
);

const failed = results.filter((item) => !item.pass);
for (const item of results) console.log(`${item.pass ? "  ok" : "  FAIL"}  ${item.name}${item.pass || !item.detail ? "" : "  [" + item.detail + "]"}`);
console.log(`\nlive-check: passed ${results.length - failed.length} / failed ${failed.length}`);
if (failed.length > 0) process.exit(1);
