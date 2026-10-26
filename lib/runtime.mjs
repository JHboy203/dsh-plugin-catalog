/**
 * runtime.mjs — **运行期真相层**（纯函数，不 import fs、不碰宿主）。
 *
 * 为什么需要这一层（R35）：
 *   目录里的「会不会被加载」是**声明层**判据（`dsh.profile.bundles` + profile 组合文件）。
 *   它看不见宿主 Loader 里真实发生了什么，于是三类事一直抓不到：
 *     ① `fiberPhase === "failed"` —— 插件被加载了但 apply 抛错（本机 2026-10-21 那次
 *        `Invalid effect` 就是这个：面板照常渲染、工具与路由全无）；
 *     ② **声明在 bundles 里，但 Loader 里根本没有这一条** —— 宿主启动时按版本/依赖判
 *        `skipping profile bundle …`（同日 3 个 bundle 因此被判 incompatible 直接 skip）；
 *     ③ `enabled: false` 但 fiber 是 active —— 声明与运行时打架。
 *
 * 判据来源：宿主 `pluginManager.listPlugins()` 的 `PluginInventoryEntry`
 *   `{ entryId, moduleName, enabled, fiberPhase }`（phase: pending/loading/active/failed/unloading/null）
 *   + 可选 `patchId`（能通过 profile patch 管理）与 `readOnlyReason`。
 *
 * ★ 三条边界（别推翻）：
 *   1. 这里是**对账**，不是第二套加载判据：`loadState` 仍由 `loadstate.mjs` 决定；
 *      本模块只回答「声明说会跑，运行时里它到底跑没跑」。
 *   2. `moduleName` 可能带子路径（`pkg/sub`），按包名归一后再比 —— 直接字符串相等会漏。
 *   3. 读不到运行期（旧宿主 / 没有 pluginManager）时**一律 unknown**，绝不猜成 active。
 *
 * @module dsh-plugin-catalog/runtime
 */

import { packageNameOf } from "./composition.mjs";

/** 运行期自述版本（进 `/state.runtime.version`，客户端按它判断字段在不在）。 */
export const RUNTIME_VERSION = 1;

/** 宿主 fiber 的六个相位（与 `PluginFiberPhase` 一致）。 */
export const FIBER_PHASES = Object.freeze(["pending", "loading", "active", "failed", "unloading", null]);

/** 对账后的运行期状态。`declared-absent` 是本层新增的那一类（声明会加载、loader 里没有）。 */
export const RUNTIME_STATES = Object.freeze(["active", "failed", "pending", "loading", "unloading", "disabled", "declared-absent", "unknown"]);

/** 状态 → 面板文案 / 色调。文案只在这里写一次（卡片 chip、浮窗、工具、报告共用）。 */
export const RUNTIME_META = Object.freeze({
	active: { label: "运行中", tone: "ok", text: "Loader 里是 active，正在跑" },
	failed: { label: "运行期失败", tone: "bad", text: "Loader 里是 failed：apply 抛过错，它的工具与路由多半已经回滚" },
	pending: { label: "等待加载", tone: "warn", text: "Loader 里是 pending：还没轮到它" },
	loading: { label: "加载中", tone: "warn", text: "Loader 里是 loading" },
	unloading: { label: "卸载中", tone: "muted", text: "Loader 里是 unloading" },
	disabled: { label: "已停用", tone: "muted", text: "Loader 里 enabled=false：装着的，但不会跑" },
	"declared-absent": { label: "不在 loader", tone: "warn", text: "声明层说它会被加载，但 Loader 里没有这一条 —— 宿主启动时很可能 skip 了它" },
	unknown: { label: "", tone: "muted", text: "读不到运行期（旧宿主或没有 pluginManager）" },
});

/** 一条运行期记要（从 `listPlugins()` 的一行归一出来）。 */
export function normalizeRuntimeRow(row) {
	if (!row || typeof row !== "object") return null;
	const moduleName = String(row.moduleName || "");
	const pkg = packageNameOf(moduleName) || moduleName;
	const phase = row.fiberPhase === undefined ? null : row.fiberPhase;
	return {
		entryId: String(row.entryId || ""),
		moduleName,
		packageName: pkg,
		enabled: row.enabled !== false,
		phase: phase === null || phase === undefined ? null : String(phase),
		patchId: String(row.patchId || ""),
		readOnlyReason: row.readOnlyReason ? String(row.readOnlyReason) : "",
		title: row.meta && row.meta.title ? String(typeof row.meta.title === "string" ? row.meta.title : row.meta.title.en || "") : "",
	};
}

/** 一条 bundle 记要（从 `listBundles()` 的一行归一出来）。 */
export function normalizeBundleRow(row) {
	if (!row || typeof row !== "object") return null;
	const name = String(row.name || "");
	if (name === "") return null;
	return {
		name,
		enabled: row.enabled !== false,
		availability: String(row.availability || ""),
		removable: row.removable === true,
		error: row.error && row.error.code ? String(row.error.code) : "",
		version: row.version ? String(row.version) : "",
	};
}

/**
 * 把 `listPlugins()`（+ 可选 `listBundles()`）编成索引。
 *
 * 同一个包可能有多条 loader 条目（例如 `pkg` 与 `pkg/sub`）：**按包名取"最能说明问题"的那条** ——
 * failed 优先，其次 active，再其次其它；否则读到哪条算哪条会让同一个包一会儿绿一会儿红。
 *
 * ★ 为什么还要 `listBundles()`：**bundle 是"层"，不一定是 loader 条目**。本机 `@deepseek-ai/dsh-base`
 *   是官方的大 patch 层（96 条 insert），它自己并不作为插件运行；把"bundle 不在 listPlugins 里"
 *   判成"被 skip 了"会得到 7 条假警报（R35 真机第一跑就是）。所以"声明会加载但 loader 里没有"
 *   只对**非 bundle** 的普通插件成立；bundle 的健康状况看 `listBundles()` 的
 *   `availability / error`（它才是宿主自己的说法）。
 *
 * @param {Array<object>} list `pluginManager.listPlugins()` 的返回
 * @param {object} [options]
 * @param {Array<object>} [options.bundles] `pluginManager.listBundles()` 的返回（可选）
 * @returns {{ok:boolean, rows:Array<object>, byPackage:Map<string,object>, byEntry:Map<string,object>, counts:object,
 *   bundles:{rows:Array<object>, byName:Map<string,object>, names:Set<string>, problems:Array<object>}|null}}
 */
export function indexRuntime(list, options = {}) {
	const rows = (Array.isArray(list) ? list : []).map(normalizeRuntimeRow).filter(Boolean);
	const byEntry = new Map(rows.map((row) => [row.entryId, row]));
	const byPackage = new Map();
	const weight = (row) => (row.phase === "failed" ? 0 : row.phase === "active" ? 1 : row.enabled ? 2 : 3);
	for (const row of rows) {
		const previous = byPackage.get(row.packageName);
		if (!previous || weight(row) < weight(previous)) byPackage.set(row.packageName, row);
	}
	let bundles = null;
	if (Array.isArray(options.bundles)) {
		const bundleRows = options.bundles.map(normalizeBundleRow).filter(Boolean);
		const byName = new Map(bundleRows.map((row) => [row.name, row]));
		let problems = [];
		for (const row of bundleRows) {
			/* ★ 只对**被选中的** bundle 报问题：`listBundles()` 还会列出"离线官方目录里可选、但没装"的
			   bundle（本机 `@deepseek-ai/dsh-subagent-claude-code` / `-codex` 就是：availability=missing、
			   enabled=false）。那是"可选未装"，不是故障；把它算成 missing 会让面板永远挂着两条假警报。 */
			if (row.enabled !== true) continue;
			if (row.availability === "missing") problems.push({ name: row.name, kind: "missing", text: "宿主说这个 bundle **找不到**（不在 profile、也不在官方安装里）—— 启用它时宿主会失败" });
			else if (row.error !== "") problems.push({ name: row.name, kind: "error", text: "宿主给这个 bundle 报了错：" + row.error });
		}
		bundles = { rows: bundleRows, byName, names: new Set(bundleRows.map((row) => row.name)), problems };
	}
	return {
		ok: rows.length > 0,
		rows,
		byPackage,
		byEntry,
		bundles,
		counts: {
			total: rows.length,
			active: rows.filter((row) => row.phase === "active").length,
			failed: rows.filter((row) => row.phase === "failed").length,
			pending: rows.filter((row) => row.phase === "pending" || row.phase === "loading").length,
			disabled: rows.filter((row) => row.enabled === false).length,
			nullPhase: rows.filter((row) => row.phase === null).length,
		},
	};
}

/**
 * 对账（纯函数）：声明层的一条插件 → 运行期状态。
 *
 * @param {object} entry 目录条目（至少 `kind` / `name` / `packageName` / `loadState` / `enabled`）
 * @param {{byPackage?:Map<string,object>}|null} index `indexRuntime()` 的结果；null = 读不到
 * @returns {{available:boolean, state:string, phase:string|null, entryId:string, patchId:string, enabled:boolean|null, managed:boolean, issue:string, detail:string}}
 */
export function runtimeOf(entry, index) {
	const empty = { available: false, state: "unknown", phase: null, entryId: "", patchId: "", enabled: null, managed: false, issue: "", detail: "" };
	if (!entry || entry.kind !== "plugin") return empty;
	if (!index || !(index.byPackage instanceof Map)) return empty;
	const candidates = [entry.packageName, entry.name, entry.aliasOf].filter(Boolean).map(String);
	let row = null;
	for (const name of candidates) {
		row = index.byPackage.get(name) || index.byPackage.get(packageNameOf(name));
		if (row) break;
	}
	const declaredLoaded = entry.loadState === "bundle" || entry.loadState === "config" || entry.loadState === "transitive";
	if (!row) {
		/* 「声明会加载、Loader 里却没有」只在**确实该有 loader 条目**时成立：
		   · `transitive`：那是 npm 依赖（本机 `@dsh-ops/bash-win32-x64` 是原生二进制，本来就不注册插件）；
		   · `bundle` 且它在 `listBundles()` 里：bundle 是**层**，它的 patch 插入的条目才是插件
		     （本机 `@deepseek-ai/dsh-base` 就是 96 条的官方大层）。
		   把这两类判成 absent 会得到一片假警报 —— R35 真机第一跑就是 7 条假警报。 */
		const isBundleLayer = Boolean(index.bundles && index.bundles.names && index.bundles.names.has(entry.packageName));
		const shouldHaveEntry = entry.loadState === "config" || (entry.loadState === "bundle" && !isBundleLayer);
		if (declaredLoaded && shouldHaveEntry) {
			return { ...empty, available: true, state: "declared-absent", detail: "声明层：" + (entry.loadState || "?") + (entry.loadVia ? " · 随 " + entry.loadVia : "") + "；运行时：Loader 里没有这一条" };
		}
		return empty;
	}
	const phase = row.phase;
	let state = "unknown";
	if (phase === "failed") state = "failed";
	else if (phase === "pending") state = "pending";
	else if (phase === "loading") state = "loading";
	else if (phase === "unloading") state = "unloading";
	else if (phase === "active") state = "active";
	else if (row.enabled === false) state = "disabled";
	/* active 但 enabled=false：fiber 还在跑、声明已关（宿主可能要等重启） */
	let issue = "";
	if (state === "failed") issue = "fiberPhase=failed：apply 抛过错，它的工具/路由可能已经被回滚（看 logs/apply-trace.log 与 plugin_manager 的 diagnostic）";
	else if (state === "active" && row.enabled === false) issue = "enabled=false 但 fiber 仍是 active：声明已停用，运行时还没卸（通常要重启 DSH）";
	else if (state === "active" && entry.enabled === false && !(index.bundles && index.bundles.names.has(entry.packageName))) issue = "在 bundles 里已经去掉，但 fiber 仍 active：这条入口下次启动才真正消失";
	else if ((state === "pending" || state === "loading") && declaredLoaded) issue = "";
	else if (state === "disabled" && declaredLoaded) issue = "声明层说会加载（" + entry.loadState + "），但 Loader 里 enabled=false：两边不一致";
	const detail = [
		"运行时：" + (phase === null ? "没有 fiber（null）" : phase),
		"enabled=" + (row.enabled ? "true" : "false"),
		row.entryId ? "entry " + row.entryId : "",
		row.patchId ? "patch " + row.patchId : "只读（" + (row.readOnlyReason || "?") + "）",
		declaredLoaded ? "声明层 " + entry.loadState + (entry.loadVia ? " · 随 " + entry.loadVia : "") : "声明层不加载",
	]
		.filter(Boolean)
		.join(" · ");
	return {
		available: true,
		state,
		phase,
		entryId: row.entryId,
		patchId: row.patchId,
		enabled: row.enabled,
		managed: Boolean(row.patchId),
		readOnlyReason: row.readOnlyReason,
		issue,
		detail,
	};
}

/**
 * 批量对账（**不修改入参**）：给每条插件条目补上运行期字段。
 *
 * 纯函数：返回新数组；非插件条目原样返回。
 *
 * @param {Array<object>} entries
 * @param {{byPackage?:Map<string,object>}|null} index
 */
export function mergeRuntime(entries, index) {
	return (Array.isArray(entries) ? entries : []).map((entry) => {
		if (!entry || entry.kind !== "plugin") return entry;
		const runtime = runtimeOf(entry, index);
		return {
			...entry,
			runtimeState: runtime.state,
			runtimePhase: runtime.phase,
			runtimeEntryId: runtime.entryId,
			runtimeManaged: runtime.managed,
			runtimeEnabled: runtime.enabled,
			runtimeIssue: runtime.issue,
			runtimeDetail: runtime.detail,
		};
	});
}

/** 一条条目的运行期文案（卡片 chip / 浮窗 / 工具三处共用）。 */
export function runtimeLabel(entry) {
	if (!entry || entry.kind !== "plugin") return "";
	const state = String(entry.runtimeState || "unknown");
	const meta = RUNTIME_META[state];
	if (!meta || meta.label === "") return "";
	/* 「运行中」对绝大多数插件是废话 —— 只在它和声明层不一致、或者不是 active 时才占版面。
	   这样 100 多张卡片不会每张都顶一个绿标。 */
	if (state === "active" && !entry.runtimeIssue) return "";
	return meta.label;
}

/** chip 的 title（悬停解释「凭什么」）。 */
export function runtimeTitle(entry) {
	if (!entry || entry.kind !== "plugin") return "";
	const state = String(entry.runtimeState || "unknown");
	const meta = RUNTIME_META[state] || RUNTIME_META.unknown;
	return [meta.text, entry.runtimeIssue, entry.runtimeDetail].filter(Boolean).join("\n");
}

/** 运行期的三类"要人看"的问题（面板洞察条 / health / 交接单 / 工具共用同一份判据）。 */
export function runtimeIssues(entries) {
	const list = Array.isArray(entries) ? entries : [];
	const failed = list.filter((entry) => entry && entry.kind === "plugin" && entry.runtimeState === "failed");
	const absent = list.filter((entry) => entry && entry.kind === "plugin" && entry.runtimeState === "declared-absent");
	const mismatch = list.filter(
		(entry) =>
			entry &&
			entry.kind === "plugin" &&
			/* ① fiber 还在跑，但声明已经关掉/去掉；② Loader 说停用，而声明层说它会加载 */
			((entry.runtimeState === "active" && Boolean(entry.runtimeIssue)) ||
				(entry.runtimeState === "disabled" && (entry.loadState === "bundle" || entry.loadState === "config" || entry.loadState === "transitive"))),
	);
	return {
		failed,
		absent,
		mismatch,
		total: failed.length + absent.length + mismatch.length,
		names: { failed: failed.map((entry) => entry.name), absent: absent.map((entry) => entry.name), mismatch: mismatch.map((entry) => entry.name) },
	};
}

/** 一句话摘要（health / 工具 / 报告；读不到就说读不到，不写成 0）。 */
export function summarizeRuntime(report) {
	if (!report) return "运行期：还没读";
	if (!report.available) return "运行期：读不到（" + (report.reason || "宿主没有 pluginManager.listPlugins") + "）";
	const counts = report.counts || {};
	const issues = report.issues || {};
	const parts = ["运行期：Loader 里 " + (counts.total || 0) + " 条（active " + (counts.active || 0) + " / failed " + (counts.failed || 0) + " / 等待 " + (counts.pending || 0) + " / 停用 " + (counts.disabled || 0) + "）"];
	if ((issues.failed || 0) > 0) parts.push("⚠️ 运行期失败 " + issues.failed + "（" + (issues.names?.failed || []).slice(0, 3).join("、") + "）");
	if ((issues.absent || 0) > 0) parts.push("⚠️ 声明会加载但 Loader 里没有 " + issues.absent + "（" + (issues.names?.absent || []).slice(0, 3).join("、") + "）");
	if ((issues.mismatch || 0) > 0) parts.push("⚠️ 声明与运行时不一致 " + issues.mismatch);
	const bundleProblems = (report.bundles && report.bundles.problems) || [];
	if (bundleProblems.length > 0) parts.push("⚠️ bundle 有问题 " + bundleProblems.length + "（" + bundleProblems.slice(0, 3).map((item) => item.name).join("、") + "）");
	if (parts.length === 1) parts.push("没有发现失败或缺失");
	return parts.join("｜");
}
