/**
 * handoff.mjs — 「换会话之前，这张交接单够不够」的纯函数（R26）。
 *
 * 为什么单独一层：交接时要回答的都不是新数据，而是**几份既有结论的交叉核对** ——
 * 磁盘 vs 运行中（R18 的 loaded）、自检最新一份（dev/ship 报告）、未提交 / 未推送、
 * Skill staging 是否旧、配置层有没有缺口、变化与历史是否说得清。
 * 面板的 health 逐项都能看，但没有人把「能不能交接」压成一个结论；换会话时人会漏看一项。
 *
 * ★ 只做判断与排版，不读盘：数据由 service 收集后传进来，于是 `dev/probe-handoff.mjs`
 *   能在合成数据上把这些判断跑一遍（与 history / composition 同一条纪律）。
 *
 * @module dsh-plugin-catalog/handoff
 */

export const HANDOFF_VERSION = 1;

const push = (list, id, label, status, detail) => list.push({ id, label, status, detail: String(detail || "") });

/**
 * @param {object} input
 * @param {{version:string,at:number,stale:boolean,newestFile:string}} input.build 磁盘构建戳
 * @param {{version:string,at:number}} input.loaded 模块加载时版本
 * @param {number} input.tools 已注册工具数
 * @param {{line:string,verdict:string,counts:object,packages:object,bundles:object}} [input.composition]
 * @param {object|null} [input.changes] changesSummary()
 * @param {object|null} [input.ack] health.ack
 * @param {{total:number}} [input.timeline]
 * @param {{count:number,items?:Array}} [input.drift]
 * @param {{path:string,at:number,passed:number,failed:number,version:string}|null} [input.ship]
 * @param {{head:string,branch:string,dirty:number,ahead:number,behind:number}|null} [input.git]
 * @param {{path:string,at:number}|null} [input.report]
 * @param {number} [input.now]
 */
export function buildHandoff(input = {}) {
	const now = Number(input.now) || Date.now();
	const checks = [];
	const build = input.build || {};
	const loaded = input.loaded || {};
	const stale = Boolean(build.version) && Boolean(loaded.version) && String(build.version) !== String(loaded.version);
	push(
		checks,
		"version",
		"磁盘 vs 运行中",
		stale ? "bad" : build.version ? "ok" : "warn",
		stale
			? `运行中 ${loaded.version} / 磁盘 ${build.version} —— 重启 DSH 后才生效（set_plugin 不会重新 import 模块）`
			: `运行中 ${loaded.version || "?"} = 磁盘 ${build.version || "?"}`,
	);
	push(checks, "tools", "catalog_* 工具", Number(input.tools) === 12 ? "ok" : "warn", `注册 ${Number(input.tools) || 0} 个（预期 12）`);
	const composition = input.composition;
	push(
		checks,
		"composition",
		"配置层",
		composition ? (composition.verdict === "bad" ? "bad" : composition.verdict === "warn" ? "warn" : "ok") : "warn",
		composition ? composition.line : "没读到组合文件",
	);
	const counts = input.changes?.counts || null;
	push(
		checks,
		"changes",
		"变化",
		counts ? (Number(counts.composition) > 0 ? "warn" : "ok") : "warn",
		counts
			? `自 ${new Date(Number(input.changes.baselineAt) || 0).toLocaleString("zh-CN", { hour12: false })} 起 ${counts.total} 处（配置层 ${counts.composition || 0}）；${input.ack?.at ? "已标记看过 " + new Date(Number(input.ack.at)).toLocaleString("zh-CN", { hour12: false }) : "还没标记过"}`
			: "还没有变化快照",
	);
	push(checks, "history", "历史", Number(input.timeline?.total) > 1 ? "ok" : "warn", `${Number(input.timeline?.total) || 0} 条快照`);
	push(
		checks,
		"staging",
		"Skill staging",
		Number(input.drift?.count) > 0 ? "warn" : "ok",
		Number(input.drift?.count) > 0 ? `${input.drift.count} 个是旧的 —— catalog_skill_sync action=apply` : "0 个旧的",
	);
	const ship = input.ship;
	const shipParsed = Boolean(ship) && Number(ship.passed) + Number(ship.failed) > 0;
	push(
		checks,
		"ship",
		"最新发版体检",
		!ship ? "warn" : !shipParsed ? "warn" : Number(ship.failed) > 0 ? "bad" : "ok",
		!ship
			? "还没跑过 dev/ship.mjs"
			: !shipParsed
				? `${ship.path.split(/[\\/]/).pop()}：报告里没解析出通过/失败数（格式变了？）`
				: `${ship.path.split(/[\\/]/).pop()}：${ship.passed} 通过 / ${ship.failed} 失败 · ${new Date(Number(ship.at)).toLocaleString("zh-CN", { hour12: false })}`,
	);
	const git = input.git;
	push(
		checks,
		"git",
		"仓库",
		!git ? "warn" : Number(git.dirty) > 0 ? "warn" : Number(git.ahead) > 0 ? "warn" : "ok",
		!git
			? "git 状态读不到"
			: `${git.branch || "?"} @ ${git.head || "?"} · 脏 ${Number(git.dirty) || 0} · 未推送 ${Number(git.ahead) || 0} · 落后 ${Number(git.behind) || 0}`,
	);
	push(
		checks,
		"report",
		"最新目录快照",
		input.report ? "ok" : "warn",
		input.report ? `${input.report.path.split(/[\\/]/).pop()} · ${new Date(Number(input.report.at)).toLocaleString("zh-CN", { hour12: false })}` : "reports/ 里还没有导出",
	);
	const bad = checks.filter((check) => check.status === "bad").length;
	const warn = checks.filter((check) => check.status === "warn").length;
	const verdict = bad > 0 ? "bad" : warn > 0 ? "warn" : "ok";
	const next = [];
	if (stale) next.push("重启 DSH（`plugin_manager` 的 disable/enable 不会重新 import 模块）");
	if (Number(input.drift?.count) > 0) next.push("`catalog_skill_sync action=apply confirm=true`");
	if (git && Number(git.dirty) > 0) next.push("提交并推送（`host_selfcheck script=dev/git-commit.mjs`，沙箱写不了 `.git/index.lock`）");
	if (!ship) next.push("`host_selfcheck script=dev/ship.mjs`");
	if (!input.report) next.push("`catalog_export top=30`");
	const report = {
		version: HANDOFF_VERSION,
		at: now,
		verdict,
		counts: { ok: checks.filter((check) => check.status === "ok").length, warn, bad },
		checks,
		next,
		build: { version: String(build.version || ""), loaded: String(loaded.version || ""), stale },
	};
	report.markdown = renderHandoff(report);
	return report;
}

/** 交接单（Markdown）。给人看的一页：结论 → 九项核对 → 下一步。 */
export function renderHandoff(report) {
	const lines = [];
	const icon = (status) => (status === "ok" ? "✅" : status === "bad" ? "❌" : "⚠️");
	lines.push("# 交接单（dsh-plugin-catalog）", "");
	lines.push(`> 生成于 ${new Date(Number(report.at) || 0).toLocaleString("zh-CN", { hour12: false })} · 结论 **${report.verdict}**（ok ${report.counts.ok} / warn ${report.counts.warn} / bad ${report.counts.bad}）`);
	lines.push("", "| 项 | 状态 | 说明 |", "|---|---|---|");
	for (const check of report.checks) lines.push(`| ${check.label} | ${icon(check.status)} ${check.status} | ${String(check.detail).replace(/\|/g, "\\|")} |`);
	if (report.next.length > 0) {
		lines.push("", "## 下一步");
		for (const item of report.next) lines.push(`- ${item}`);
	} else {
		lines.push("", "全部核对通过 —— 可以直接换会话。");
	}
	return lines.join("\n");
}
