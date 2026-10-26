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

/**
 * 「只是旧了」在交接单上什么时候才值得提示（R34.1）。
 *
 * ★ 起因：`ageStale` 的门槛是 `catalogTtlSeconds`（默认 **5 分钟**）—— 拿它直接当 warn，
 *   意味着**只要不是刚刚重建过，交接单永远是 warn**，于是"ok / warn / bad"三档里
 *   ok 永远不出现，信号被自己稀释掉（本机 23:2x 实测：明明什么都没变，却挂着 ⚠️）。
 * ★ 口径：事实没变时，快照旧不旧**不影响结论**（loadState 由声明决定）。真正需要提醒的是
 *   "好久没重建过了 —— 万一有人绕开 profile 动了 node_modules"（手删目录 / 手工解包），
 *   那种情况只有重建一次才能看出来。所以取 6 小时：一天内正常操作不会被吵到。
 */
export const FRESH_AGE_WARN_MS = 6 * 60 * 60 * 1000;

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
 * @param {{factStale:boolean,ageStale:boolean,builtAt:number,profileTouchedAt:number,reason:string}} [input.freshness]
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
	push(checks, "tools", "catalog_* 工具", Number(input.tools) === 13 ? "ok" : "warn", `注册 ${Number(input.tools) || 0} 个（预期 13）`);
	const composition = input.composition;
	push(
		checks,
		"composition",
		"配置层",
		composition ? (composition.verdict === "bad" ? "bad" : composition.verdict === "warn" ? "warn" : "ok") : "warn",
		composition ? composition.line : "没读到组合文件",
	);
	/* R30：MCP 与配置层是两件不同的事 —— 配置层说"条目从哪来"，MCP 说"这个条目是不是一台能用的服务器"。
	   0 台不判失败（本机就可能一台都没有），但**有配置问题**或**孤儿调用**要 warn。 */
	const mcp = input.mcp;
	push(
		checks,
		"mcp",
		"MCP",
		!mcp ? "warn" : Number(mcp.counts?.withProblems) > 0 || Number(mcp.orphans?.calls) > 0 ? "warn" : "ok",
		!mcp
			? "没读到 MCP（组合文件没读或报告缺失）"
			: `${mcp.line || ""}${Number(mcp.orphans?.calls) > 0 ? `；⚠️ 孤儿调用 ${mcp.orphans.calls} 次（${(mcp.orphans.servers || []).join("、")}）` : ""}`,
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
	/* ★ R34：**这张交接单自己的数字是从目录快照来的**，所以它是唯一一项"错了会让别的项一起错"的核对。
	   事实变了（profile 比快照新）⇒ 判 bad 并排到下一步最前面：先重建，再交接。
	   只是旧（年龄超 TTL、事实没变）⇒ 只 warn，不拦 —— 结论仍然有效。 */
	const freshness = input.freshness;
	const factStale = Boolean(freshness?.factStale);
	const ageStale = Boolean(freshness?.ageStale);
	/* 年龄只在「确实很久没重建」时才提示（见 FRESH_AGE_WARN_MS 的注释：否则 verdict 永远 warn） */
	const ageMs = Number(freshness?.ageMs) > 0 ? Number(freshness.ageMs) : 0;
	const ageTooOld = ageStale && ageMs > FRESH_AGE_WARN_MS;
	push(
		checks,
		"freshness",
		"快照新鲜度",
		!freshness ? "warn" : factStale ? "bad" : ageTooOld ? "warn" : "ok",
		!freshness
			? "没读到 profile 的 mtime（无法判断快照是否对得上现实）"
			: factStale
				? `快照建于 ${new Date(Number(freshness.builtAt) || 0).toLocaleString("zh-CN", { hour12: false })}，而 profile 在 ${new Date(Number(freshness.profileTouchedAt) || 0).toLocaleString("zh-CN", { hour12: false })} 之后被改过 —— **上面这些 loadState / bundles 判断可能已经错**`
				: ageTooOld
					? `快照建于 ${new Date(Number(freshness.builtAt) || 0).toLocaleString("zh-CN", { hour12: false })}（${Math.round(ageMs / 3600000)} 小时前，超过 ${FRESH_AGE_WARN_MS / 3600000} 小时）—— profile 没动过，但**万一有人绕开 profile 动过 node_modules，只有重建一次才看得出来**`
					: ageStale
						? `${Math.round(ageMs / 60000)} 分钟前重建的；profile 没动过，四态结论仍然有效`
						: "快照与 profile 一致",
	);
	const bad = checks.filter((check) => check.status === "bad").length;
	const warn = checks.filter((check) => check.status === "warn").length;
	const verdict = bad > 0 ? "bad" : warn > 0 ? "warn" : "ok";
	const next = [];
	if (factStale) next.push('先重建目录再交接：`POST /plugin-catalog/refresh {what:"catalog"}`（或打开面板，它会自愈一次），然后**重跑 `catalog_handoff`**');
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
		/* R34：把"这张单子本身新鲜吗"也带出去（工具/报告都要能引用，不只是表格里一行） */
		freshness: freshness ? { factStale, ageStale, builtAt: Number(freshness.builtAt) || 0, profileTouchedAt: Number(freshness.profileTouchedAt) || 0 } : null,
	};
	report.markdown = renderHandoff(report);
	return report;
}

/** 交接单（Markdown）。给人看的一页：结论 → 十一项核对 → 下一步。 */
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
