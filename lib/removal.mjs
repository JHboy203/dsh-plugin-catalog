/**
 * removal.mjs — **单个已装包**的「卸载」能力（计划 + 执行 + 留痕）。
 *
 * ★ 它和 `uninstall.mjs` 是两件不同的事，别混：
 *   · `uninstall.mjs`：批量清理「不会被加载」的**目录**。红线是**只生成、绝不执行** ——
 *     命令只是字符串，`rmSync/unlink/rmdir/rm` 一个都不许出现。
 *   · 本模块：把**一个**已经装进 profile 的包交给宿主自己的 `pluginManager.removeBundle()` 卸掉。
 *     **不碰文件系统删除**，只调宿主 API；宿主自己决定 pnpm、bundle 行、组合条目怎么收。
 *     调用方必须是「别的东西」（当前是 dsh-plugin-installer 的升级流程）或人明确点的按钮；
 *     模型拿不到这个动作（没有注册成工具）。
 *
 * ★ 为什么卸载这件事要长在这里（而不是装的那一侧自己做）：
 *   卸载的判据全在这个插件手里 —— 谁依赖它、它现在会不会被加载、它是 link 还是 npm、
 *   宿主自带包不能碰。把这些判据和「动手」分开写，就会出现「面板说安全、执行时指空」。
 *   所以：**判据在这里，执行也在这里**；装/换版本仍归 dsh-plugin-installer。
 *
 * ★ 独立性（两边都不许硬依赖）：
 *   · 本模块只依赖宿主 `pluginManager`（缺了就明确拒绝，不假装成功）；
 *   · 谁都不用装另一个插件 —— 没有调用方时它就是一个安静的服务能力，
 *     面板的处置清单照旧「只生成不执行」。
 *
 * @module dsh-plugin-catalog/removal
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageNameOf, parseComposition } from "./composition.mjs";
import { isLoadedState, resolveLoadPaths, scanInstalledPackages } from "./loadstate.mjs";
import { profileBundles, profileComposition, profileDependencies, profileNodeModules } from "./hostinfo.js";
import { readJson, writeJson } from "./store.mjs";

/** 跨插件契约版本。消费方（installer）只认这个数；对不上就自己降级，不要猜字段。
 *
 *  ★ api 1（R32）：单件卸载（plan/apply/journal）。
 *  ★ api 2（R33）：+ `restore`（卸载会去掉什么、装回来要写回什么）、
 *                 + `inspect`（装完核对：这个包在目录眼里到底会不会被加载）、
 *                 + apply 回执里带 `rowDropped`（bundle 行是不是真掉了）。
 *    消费方按 `>= MIN` 取用、按 `>= 2` 用新能力 —— 旧版照样能用，**不硬依赖**。
 */
export const REMOVAL_API = 2;

/** 计划有效期：过期要重新出计划（磁盘上的版本可能已经变了）。 */
export const REMOVAL_PLAN_TTL_MS = 5 * 60 * 1000;

/** 本插件自己的包名 —— 不许自己卸自己（调用会把自己所在的运行时撕掉）。 */
export const CATALOG_PACKAGE = "dsh-plugin-catalog";

/** 宿主自带作用域：这些包不属于 profile，`removeBundle` 必然回 not-removable。 */
const HOST_SCOPE = "@deepseek-ai/";

/** 依赖声明形态 → 人话（与 installer 的 inventory 口径分开：这里只回答"卸载会不会动源码"）。 */
export function specKind(spec) {
	const text = String(spec ?? "").trim();
	if (!text) return "unknown";
	if (text.startsWith("link:") || text.startsWith("workspace:")) return "link";
	if (text.startsWith("file:") || text.startsWith("portal:")) return "file";
	if (/^(git\+|git:|github:|gitlab:|bitbucket:)/i.test(text) || /^[^@/\s]+\/[^/\s]+(#.*)?$/.test(text)) return "git";
	if (/^\d|^[~^]|^[<>=*]|^https?:/.test(text) || /^npm:/.test(text)) return "npm";
	return "other";
}

/**
 * 判据（纯函数）：一份事实 → 能不能卸、要注意什么。
 *
 * @param {object} facts
 * @param {string} facts.name
 * @param {string} [facts.purpose]      `replace`（换版本时的卸载）| `remove`（单件卸载）
 * @param {string} [facts.spec]         profile 依赖里那条声明
 * @param {string} [facts.version]      node_modules 里读到的版本
 * @param {string} [facts.loadState]    bundle / config / transitive / dormant
 * @param {string} [facts.via]          它随哪个入口被加载
 * @param {string[]} [facts.dependents] 声明依赖它的已装包
 * @param {string[]} [facts.bundles]     `dsh.profile.bundles`
 * @param {boolean} [facts.self]        是不是本插件
 * @returns {{ok:boolean, name:string, purpose:string, kind:string, version:string|null, spec:string,
 *   loadState:string, via:string, dependents:string[], blockers:Array<{code:string,text:string}>,
 *   warnings:Array<{code:string,text:string}>, text:string, why:string}}
 */
export function planPackageRemoval(facts) {
	const input = facts || {};
	const name = String(input.name ?? "").trim();
	const purpose = input.purpose === "remove" ? "remove" : "replace";
	const spec = String(input.spec ?? "");
	const kind = specKind(spec);
	const version = input.version ? String(input.version) : null;
	const loadState = String(input.loadState || "unknown");
	const via = String(input.via || "");
	const dependents = Array.isArray(input.dependents) ? input.dependents.filter(Boolean) : [];
	const bundles = Array.isArray(input.bundles) ? input.bundles : [];
	const blockers = [];
	const warnings = [];

	if (!name) blockers.push({ code: "no-name", text: "没给包名" });
	if (input.self === true || name === CATALOG_PACKAGE) {
		blockers.push({
			code: "self",
			text: "不能卸载「插件目录」自己：这条调用会把正在执行它的运行时撕掉",
		});
	}
	if (name.startsWith(HOST_SCOPE)) {
		blockers.push({
			code: "host-owned",
			text: "它是宿主自带包（" + HOST_SCOPE + "*），不属于 profile —— 宿主会回 not-removable，也不该卸",
		});
	}
	if (!spec) {
		blockers.push({
			code: "not-owned",
			text: "profile 的 dependencies 里没有它：不是这个 profile 装的，宿主不会认这个卸载请求",
		});
	}
	if (name && spec && input.installed === false) {
		warnings.push({ code: "missing-dir", text: "依赖声明在，但 node_modules 里没有它（本来就处于「声明了但没落地」状态）" });
	}
	if (kind === "link") {
		warnings.push({
			code: "link",
			text: "它是指向本机目录的 link：卸载只会去掉这条依赖，**源码目录一个字节都不会动**",
		});
	}
	if (isLoadedState(loadState)) {
		warnings.push({
			code: "loaded",
			text: "它现在**会被加载**（" + loadState + (via ? " · 随 " + via : "") + "）：从卸载到装回的窗口里，它提供的东西会消失",
		});
	}
	if (bundles.includes(name)) {
		warnings.push({ code: "bundle-row", text: "它在 dsh.profile.bundles 里 —— 卸载会同时去掉那条入口（重装时由安装方写回）" });
	}
	if (dependents.length > 0) {
		warnings.push({
			code: "dependents",
			text: "还有 " + dependents.length + " 个已装包声明依赖它（" + dependents.slice(0, 5).join("、") + (dependents.length > 5 ? " 等" : "") + "）—— 装不回来时它们也会坏",
		});
	}

	const ok = blockers.length === 0;
	const text = ok
		? (purpose === "replace" ? "可以卸载旧版（换版本）：" : "可以卸载：") + name + (version ? "@" + version : "") +
			(loadState !== "unknown" ? " · 当前 " + loadState : "")
		: "不能卸载：" + blockers.map((b) => b.text).join("；");
	/* R33：**装回来要写回什么** —— 卸载会连带去掉 bundle 行，而"装上了却没入口"是本机反复出现的坑。
	   这一份只描述事实，写回动作归安装侧（它才有 installBundle / set_bundle）。 */
	const restore = {
		bundleRow: bundles.includes(name) || input.bundleRow === true,
		composition: Array.isArray(input.compositionRows) ? input.compositionRows.slice(0, 12) : [],
		spec,
		version,
		text:
			(bundles.includes(name) || input.bundleRow === true
				? "卸载会去掉 `dsh.profile.bundles` 里的那条入口 —— 装回来时必须写回，否则「装上了但不会被加载」"
				: "不在 `dsh.profile.bundles` 里，卸载不会动入口") +
			(Array.isArray(input.compositionRows) && input.compositionRows.length > 0
				? "；另有 " + input.compositionRows.length + " 条组合条目按 name 指向它（patch 层不会被卸载删掉，重装后仍然生效）"
				: ""),
	};
	return {
		ok,
		name,
		purpose,
		kind,
		version,
		spec,
		loadState,
		via,
		dependents,
		blockers,
		warnings,
		restore,
		text,
		why: [spec ? "声明 " + spec : "无依赖声明", loadState !== "unknown" ? "加载态 " + loadState : "加载态未知"].join(" · "),
	};
}

/** 把 profile / node_modules 的**当下**事实收集起来（每次现读；不缓存 —— 卸载前的事实不能过期）。 */
export async function collectRemovalFacts({ name, purpose = "replace" } = {}) {
	const wanted = String(name ?? "").trim();
	const deps = await profileDependencies().catch(() => ({}));
	const spec = deps && typeof deps === "object" ? deps[wanted] : undefined;
	const nodeModules = profileNodeModules();
	let version = null;
	let installed = false;
	if (nodeModules) {
		try {
			const manifest = JSON.parse(await readFile(join(nodeModules, wanted, "package.json"), "utf8"));
			version = manifest && manifest.version ? String(manifest.version) : null;
			installed = true;
		} catch {
			installed = false;
		}
	}
	const bundles = await profileBundles().catch(() => []);
	const composition = await profileComposition().catch(() => ({ files: [] }));
	const compositions = (composition.files || []).flatMap((file) => parseComposition(file.text));
	/* R33：组合层里按 name 指向它的条目（只读 profile 自己那两份 —— 这两份才是"人改的那层"）。
	   卸载**不会**删掉它们（宿主只动 bundle 行与依赖行），所以它们是"装回来之后仍然生效"的部分。 */
	const compositionRows = compositions
		.filter((entry) => entry.name && packageNameOf(entry.name) === wanted)
		.map((entry) => ({ id: entry.id || "", name: entry.name, file: entry.file || "", line: Number(entry.line) || 0 }))
		.slice(0, 12);
	const scanned = nodeModules ? await scanInstalledPackages(nodeModules).catch(() => null) : null;
	const installedMap = scanned && scanned.installed instanceof Map ? scanned.installed : new Map();
	let loadState = "unknown";
	let via = "";
	if (installedMap.size > 0) {
		const paths = resolveLoadPaths({ bundles, compositions, installed: installedMap });
		const state = paths.byName.get(wanted);
		if (state) {
			loadState = state.state;
			via = state.via || "";
		}
	}
	const dependents = [];
	for (const [pkg, list] of installedMap) {
		if (pkg === wanted) continue;
		if (Array.isArray(list) && list.includes(wanted)) dependents.push(pkg);
	}
	dependents.sort((a, b) => a.localeCompare(b));
	return {
		name: wanted,
		purpose,
		spec: spec ? String(spec) : "",
		version,
		installed,
		loadState,
		via,
		dependents,
		bundles,
		bundleRow: bundles.includes(wanted),
		compositionRows,
	};
}

/** 读一份当下的装载事实（执行后复核用）：依赖行还在不在、目录还在不在。 */
export async function readRemovalFacts(name) {
	const deps = await profileDependencies().catch(() => ({}));
	const inDeps = Boolean(deps && Object.prototype.hasOwnProperty.call(deps, name));
	let dirExists = false;
	const nodeModules = profileNodeModules();
	if (nodeModules) {
		try {
			await readFile(join(nodeModules, name, "package.json"), "utf8");
			dirExists = true;
		} catch {
			dirExists = false;
		}
	}
	return {
		inDeps,
		dirExists,
		/* 判「卸掉了没有」只认依赖行：宿主判已装/未装看的就是它（R13 的 already-installed 实证） */
		removed: !inDeps,
	};
}

/** 宿主有没有这个 API（没有时给一句人话，而不是在调用处抛 undefined）。 */
export function describeRemovalHost(pluginManager) {
	const pm = pluginManager;
	const canRemove = Boolean(pm && typeof pm.removeBundle === "function");
	return {
		ok: canRemove,
		api: REMOVAL_API,
		canRemove,
		reason: canRemove ? "" : "宿主没提供 pluginManager.removeBundle（版本太旧或被禁用）",
	};
}

/** 卸载回执的人话（宿主返回 { changed, application, stage, target, error }）。 */
export function summarizeRemovalResult(result) {
	const value = result || {};
	const error = value.error || null;
	const application = value.application ? String(value.application) : "";
	const failed = application === "failed" || Boolean(error && error.code && error.code !== "unknown-plugin");
	const code = error && error.code ? String(error.code) : "";
	return {
		ok: !failed,
		changed: value.changed === true,
		application,
		stage: value.stage ? String(value.stage) : "",
		code,
		/* unknown-plugin：本来就不在 —— 对"卸掉"这个目标而言算达成，但要说清 */
		alreadyGone: code === "unknown-plugin",
		error: error ? { code, message: String(error.message || error.diagnostic || code), diagnostic: error.diagnostic ? String(error.diagnostic) : "" } : null,
	};
}

/**
 * 执行一次卸载。**调用前必须先 planPackageRemoval 通过**（这里再核一遍事实，防"计划过期"）。
 *
 * @param {object} input
 * @param {object} input.pluginManager 宿主插件管理服务
 * @param {object} input.plan           planPackageRemoval 的结果（至少带 name/purpose/version）
 * @param {string} [input.requestedBy]  谁要求的（installer 任务 id / panel）
 * @param {(name:string)=>Promise<object>} [input.verify] 执行后的复核（默认 readRemovalFacts）
 * @returns {Promise<object>}
 */
export async function executePackageRemoval(input) {
	const plan = input && input.plan ? input.plan : {};
	const name = String(plan.name ?? "").trim();
	const host = describeRemovalHost(input && input.pluginManager);
	if (!name) return { ok: false, code: "no-name", error: "没给包名" };
	if (!host.ok) return { ok: false, code: "no-host-api", error: host.reason };
	if (!plan.ok) return { ok: false, code: "plan-not-ok", error: plan.text || "计划本身不允许卸载", blockers: plan.blockers || [] };

	const before = await collectRemovalFacts({ name, purpose: plan.purpose || "replace" });
	/* ★ 计划过期：版本或声明变了就拒绝 —— 拿旧计划去卸新装的版本，是把"安全"建在过期事实上。 */
	if (!before.spec) return { ok: false, code: "not-owned", error: "执行前复核：profile 的 dependencies 里已经没有它了" };
	if (plan.version && before.version && String(plan.version) !== String(before.version)) {
		return {
			ok: false,
			code: "stale-plan",
			error: "磁盘上的版本已经从 " + plan.version + " 变成 " + before.version + "，重新出一次计划再卸",
		};
	}

	let result = null;
	let thrown = null;
	try {
		result = await input.pluginManager.removeBundle(name);
	} catch (error) {
		thrown = { message: String(error && error.message ? error.message : error), code: String((error && error.code) || "") };
	}
	const summary = summarizeRemovalResult(result);
	const verify = typeof input.verify === "function" ? input.verify : readRemovalFacts;
	const after = await verify(name).catch(() => ({ removed: false, inDeps: true, dirExists: true }));
	/* R33：bundle 行是不是真掉了 —— 这是「装回来会不会没入口」唯一的事实来源。 */
	let bundlesAfter = [];
	try {
		bundlesAfter = await (typeof input.readBundles === "function" ? input.readBundles() : profileBundles());
	} catch {
		bundlesAfter = [];
	}
	const hadRow = before.bundles.includes(name);
	const rowDropped = hadRow && !bundlesAfter.includes(name);
	/* 复核才是结论：宿主回 applied 但依赖行还在，就等于没卸掉。 */
	const ok = !thrown && summary.ok && after.removed === true;
	return {
		ok,
		name,
		requestedBy: input.requestedBy ? String(input.requestedBy) : "",
		purpose: plan.purpose || "replace",
		from: before.version,
		spec: before.spec,
		application: summary.application,
		changed: summary.changed,
		stage: summary.stage,
		code: thrown ? "host-threw" : summary.code,
		alreadyGone: summary.alreadyGone,
		error: thrown ? thrown.message : (summary.error && summary.error.message) || (ok ? "" : "宿主回执说卸掉了，但 profile 里仍有这条依赖"),
		diagnostic: summary.error ? summary.error.diagnostic : "",
		verified: { removed: after.removed === true, inDeps: after.inDeps === true, dirExists: after.dirExists === true },
		/* R33：换版本的第二阶段（装新版）必须知道"入口掉了没有" */
		rowDropped,
		restore: { bundleRow: rowDropped, needsWriteBack: rowDropped, text: rowDropped ? "bundle 行已随卸载去掉，装回新版后要写回 `dsh.profile.bundles`，否则它不会被加载" : "bundle 行没有变化" },
		before: { spec: before.spec, version: before.version, loadState: before.loadState, dependents: before.dependents },
		at: Date.now(),
	};
}

/* ───────────── R33：装完核对（inspect） ───────────── */

/** inspect 的结论码（消费方按 code 判断，不解析文案）。 */
export const INSPECT_CODES = Object.freeze([
	"loaded",
	"installed-not-loaded",
	"not-installed",
	"declared-only",
	"host-owned",
	"self",
	"no-name",
]);

/**
 * 判据（**纯函数**）：一个包在"目录"眼里现在是什么状态。
 *
 * ★ 用途是**跨插件的第二意见**：安装器只知道自己"装上去了"（宿主回 applied），
 *   但"装上 ≠ 会被加载"在本机反复出现（不在 bundles / 没有配置条目 / 不在依赖链上）。
 *   判据在这里只有一份（`isLoadedState` / `loadState`），安装器不要自己再判一遍。
 *
 * @param {object} facts `{name, installed, version, loadState, via, bundleRow|bundles, spec, dependents, drift}`
 * @returns {{ok:boolean, code:string, text:string, warnings:Array<{code:string,text:string}>, facts:object}}
 */
export function inspectPackageState(facts = {}) {
	const input = facts || {};
	const name = String(input.name ?? "").trim();
	const installed = input.installed === true;
	const version = input.version ? String(input.version) : null;
	const loadState = String(input.loadState || "unknown");
	const via = String(input.via || "");
	const spec = String(input.spec || "");
	const bundleRow = input.bundleRow === true || (Array.isArray(input.bundles) && input.bundles.includes(name));
	const dependents = Array.isArray(input.dependents) ? input.dependents.filter(Boolean) : [];
	const warnings = [];
	if (!installed && spec) warnings.push({ code: "declared-only", text: "依赖行在，但 node_modules 里没有它（声明了没落地）" });
	if (installed && !bundleRow && loadState !== "unknown" && !isLoadedState(loadState)) {
		warnings.push({
			code: "no-entry",
			text: "它不在 `dsh.profile.bundles` 里，加载态是 " + loadState + " —— 装回来的插件要写回那条入口才会被加载",
		});
	}
	if (dependents.length > 0) warnings.push({ code: "dependents", text: "有 " + dependents.length + " 个已装包声明依赖它" });
	if (input.drift && input.drift.verdict && input.drift.verdict !== "same" && input.drift.verdict !== "linked") {
		warnings.push({ code: "drift", text: "副本与工作区源码不同步（" + input.drift.verdict + "）：跑的是 profile 里那份" });
	}
	if (specKind(spec) === "link") warnings.push({ code: "link", text: "link 安装：改源码即生效，不需要重装" });

	let code = "no-name";
	let text = "没给包名";
	if (name) {
		if (name === CATALOG_PACKAGE) {
			code = "self";
			text = "这是「插件目录」自己（" + CATALOG_PACKAGE + "）";
		} else if (name.startsWith(HOST_SCOPE)) {
			code = "host-owned";
			text = "宿主自带包（" + HOST_SCOPE + "*）：不在 profile 里，也不该由 profile 管";
		} else if (!installed && !spec) {
			code = "not-installed";
			text = "没装：profile 依赖与 node_modules 里都没有 " + name;
		} else if (!installed) {
			code = "declared-only";
			text = "只有依赖声明（" + spec + "），node_modules 里没有它";
		} else if (isLoadedState(loadState)) {
			code = "loaded";
			text = "会被加载（" + loadState + (via ? " · 随 " + via : "") + (bundleRow ? " · 在 bundles" : "") + "）";
		} else {
			code = "installed-not-loaded";
			text =
				"装了但**不会被加载**" +
				(loadState !== "unknown" ? "（" + loadState + "）" : "") +
				"：不在 bundles、没有配置条目、也不在任何依赖链上 —— 装完要写回 `dsh.profile.bundles`";
		}
	}
	return {
		ok: code === "loaded",
		code,
		text,
		warnings,
		facts: { name, installed, version, loadState, via, bundleRow, spec, dependents },
	};
}

/* ───────────── 留痕（每次真卸载一条，最多 50 条） ───────────── */

export const REMOVAL_JOURNAL_VERSION = 1;
export const REMOVAL_JOURNAL_LIMIT = 50;

export async function readRemovalJournal(file) {
	const data = await readJson(file, null);
	if (!data || data.version !== REMOVAL_JOURNAL_VERSION || !Array.isArray(data.items)) {
		return { version: REMOVAL_JOURNAL_VERSION, items: [] };
	}
	return data;
}

export async function appendRemovalJournal(file, entry) {
	const journal = await readRemovalJournal(file);
	journal.items.push(entry);
	journal.items = journal.items.slice(-REMOVAL_JOURNAL_LIMIT);
	await writeJson(file, journal);
	return journal;
}
