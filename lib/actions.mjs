/**
 * actions.mjs — 面板上**一条卡片的动作**的判据层（纯函数，不碰磁盘）。
 *
 * R35 给面板加了三个"会真改东西"的动作：
 *   · 插件：`uninstall`（交给宿主 `removeBundle`）/ `disable` / `enable`
 *   · Skill：`delete`（**移到回收站**，可还原；绝不硬删）
 *   · MCP：`disable`（往 profile patch 追加一条 `disabled: true`）/ `remove`（从组合文件里删掉条目块）
 *
 * 三条纪律（写在这里，防止下一个把边界推走）：
 *   1. **判据与执行分开**：本模块只回答"能不能、会发生什么、要注意什么"，不 import fs、
 *      不动一行文件；真动作在 `dispose.mjs`（写前备份）与 service（调宿主 API）。
 *   2. **危险动作必须两段式**：先出计划（带 blockers/warnings/preview），
 *      再要一次性 token + `confirm:true` 才执行。计划不进 localStorage，过期（5 分钟）作废。
 *   3. **能可逆就做成可逆**：Skill 删除 = 移进 `<数据目录>/trash/skills/`；
 *      MCP 删除/停用前把原文件备份成 `.bak-<时间戳>`；插件删除交给宿主自己的卸载语义。
 *
 * @module dsh-plugin-catalog/actions
 */

import { packageNameOf, parseComposition } from "./composition.mjs";
import { planPackageRemoval } from "./removal.mjs";

/** 动作层的契约版本（进 `/state.actions.version`；客户端按它判断字段在不在）。 */
export const ACTIONS_VERSION = 1;

/** 计划有效期。与单件卸载同一口径：拿旧计划去改新文件，是把安全建在过期事实上。 */
export const ACTION_PLAN_TTL_MS = 5 * 60 * 1000;

/** 允许的动作名（冻结；客户端与路由都只认这几个）。 */
export const ACTION_OPS = Object.freeze(["uninstall", "disable", "enable", "delete", "remove"]);

/** 动作 → 人话（按钮、确认文案、结果文案三处共用）。 */
export const ACTION_META = Object.freeze({
	uninstall: { label: "卸载", confirm: "确认卸载", dangerous: true, effect: "立即生效（宿主会卸包并去掉入口）", verb: "卸载" },
	disable: { label: "停用", confirm: "确认停用", dangerous: false, effect: "立即生效（保留文件与依赖，只摘掉启用状态）", verb: "停用" },
	enable: { label: "启用", confirm: "确认启用", dangerous: false, effect: "立即生效（写回启用状态）", verb: "启用" },
	delete: { label: "删除", confirm: "确认删除", dangerous: true, effect: "立即从 Skills 根目录移走（进回收站，可还原）", verb: "删除" },
	remove: { label: "删除条目", confirm: "确认删除条目", dangerous: true, effect: "改写组合文件（删掉这一段），**重启 DSH** 才生效", verb: "删除" },
});

/** 回收站目录（数据目录下；与插件安装目录分开，重装插件不会丢）。 */
export function skillTrashRoot(dataDir) {
	const base = String(dataDir || "").replace(/[\\/]+$/, "");
	const sep = base.includes("\\") ? "\\" : "/";
	return base + sep + "trash" + sep + "skills";
}

/** 归一化路径用于比较（大小写不敏感、统一斜杠、去掉尾部分隔符）。 */
export function normalizePath(path) {
	return String(path ?? "")
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/** 一个路径是否在某个根目录里（同根也算；跨盘/前缀相同的兄弟目录不算）。 */
export function isInside(child, parent) {
	const a = normalizePath(child);
	const b = normalizePath(parent);
	if (a === "" || b === "") return false;
	return a === b || a.startsWith(b + "/");
}

/**
 * 插件条目的可用动作（同步、纯函数）。
 *
 * @param {object} entry 目录条目（plugin）
 * @param {object} [options]
 * @param {object} [options.runtime] `runtimeOf()` 的结果
 * @param {boolean} [options.hostApi] 宿主有没有 pluginManager.removeBundle
 * @param {string} [options.selfPackage] 本插件包名（不允许自己卸自己）
 * @returns {Array<object>} 每个动作 `{op, label, available, blocked, blockers, warnings, summary, target, effect}`
 */
export function planPluginActions(entry, options = {}) {
	const item = entry || {};
	const runtime = options.runtime || {};
	const selfPackage = String(options.selfPackage || "dsh-plugin-catalog");
	const name = String(item.packageName || item.name || "");
	const ops = [];
	if (!name) return ops;

	/* ① 卸载 —— 判据复用 removal.mjs（同一个 planPackageRemoval，不另写一套） */
	const removal = planPackageRemoval({
		name,
		purpose: "remove",
		spec: item.dependency || "",
		version: item.version || null,
		loadState: item.loadState || "unknown",
		via: item.loadVia || "",
		dependents: item.dependents || [],
		bundles: item.enabled === true ? [name] : [],
		self: name === selfPackage,
		installed: Boolean(item.realDir) || item.inAsar === true,
	});
	const uninstallWarnings = removal.warnings.slice();
	if (runtime.state === "failed") {
		uninstallWarnings.push({ code: "runtime-failed", text: "它现在**运行期失败**（fiberPhase=failed）：卸载会顺手把它留下的失败状态一起清掉，是安全的" });
	}
	if (runtime.state === "active") {
		uninstallWarnings.push({ code: "runtime-active", text: "它现在正在跑（fiberPhase=active）：卸载会立刻把它提供的工具/界面拿掉" });
	}
	if (options.hostApi === false) {
		removal.blockers.push({ code: "no-host-api", text: "宿主没有提供 pluginManager.removeBundle：这一版没法替你卸" });
	}
	ops.push({
		op: "uninstall",
		label: ACTION_META.uninstall.label,
		available: removal.blockers.length === 0,
		blocked: removal.blockers.length > 0,
		blockers: removal.blockers,
		warnings: uninstallWarnings,
		summary: "宿主会卸掉 " + name + (item.version ? "@" + item.version : "") + "：去掉 profile 依赖" + (item.enabled ? "、`dsh.profile.bundles` 里那条入口" : "") + "，并删掉 node_modules 里那份。" + (item.isLink ? "（它是指向工作区的 link：源码目录一个字节都不会动。）" : ""),
		target: "宿主 pluginManager.removeBundle(" + name + ")",
		effect: ACTION_META.uninstall.effect,
		dangerous: true,
	});

	/* ② 停用 / 启用 —— 只在宿主能改的时候给（setBundleEnabled / setPluginEnabled） */
	const loadedNow = runtime.state === "active" || runtime.state === "pending" || runtime.state === "loading";
	const inBundles = item.enabled === true;
	const patchable = runtime.managed === true && Boolean(runtime.entryId);
	/* 已经停用（Loader enabled=false 且不在 bundles）时不再给「停用」：
	   再点一次只会写同样的值，界面却像还能做点什么。 */
	const alreadyDisabled = runtime.state === "disabled" && !inBundles;
	const disableOp = {
		op: "disable",
		label: ACTION_META.disable.label,
		available: Boolean(options.hostApi !== false) && (inBundles || patchable) && name !== selfPackage && !alreadyDisabled,
		blocked: false,
		blockers: alreadyDisabled ? [{ code: "already-disabled", text: "它现在已经是停用的（Loader enabled=false，且不在 bundles 里）—— 要恢复请用「启用」" }] : [],
		warnings: [
			...(loadedNow ? [{ code: "loaded-now", text: "它现在" + (runtime.state === "active" ? "正在跑" : "正在加载") + "：停用会立刻让它停掉（文件与依赖都保留，随时可以再启用）" }] : []),
			...(inBundles ? [] : [{ code: "not-bundle", text: "它不在 `dsh.profile.bundles` 里：停用只能改 Loader 条目的启用位，入口本身还在" }]),
		],
		summary: "保留文件与依赖，只把它从启用状态摘下来（" + (inBundles ? "从 `dsh.profile.bundles` 摘掉那一项" : "把 Loader 条目设为 enabled: false") + "）。",
		target: inBundles ? "宿主 pluginManager.setBundleEnabled(" + name + ", false)" : "宿主 pluginManager.setPluginEnabled(" + runtime.entryId + ", false)",
		effect: ACTION_META.disable.effect,
		dangerous: false,
	};
	if (!inBundles && !patchable) {
		disableOp.blockers = [{ code: "no-entry", text: "既不在 bundles、也读不到可管理的 Loader 条目（patchId 为空）：宿主没有可改的入口" }];
	}
	ops.push(disableOp);
	if (!loadedNow && item.enabled === false) {
		ops.push({
			op: "enable",
			label: ACTION_META.enable.label,
			available: Boolean(options.hostApi !== false) && (inBundles || patchable) && name !== selfPackage,
			blocked: false,
			blockers: !inBundles && !patchable ? [{ code: "no-entry", text: "既不在 bundles、也读不到可管理的 Loader 条目（patchId 为空）：宿主没有可改的入口" }] : [],
			warnings: [],
			summary: "把它重新启用（写回 `dsh.profile.bundles` 或 Loader 条目的启用位）。",
			target: inBundles ? "宿主 pluginManager.setBundleEnabled(" + name + ", true)" : "宿主 pluginManager.setPluginEnabled(" + runtime.entryId + ", true)",
			effect: ACTION_META.enable.effect,
			dangerous: false,
		});
	}
	return ops;
}

/**
 * Skill 删除的判据（纯函数）。
 *
 * 三条阻断都来自真机：插件自带的 Skill 删了等于改安装包；没有独立目录的根本没东西可移；
 * 不在已知 skill 根目录里的路径（用户手填 / 别盘）不能由面板处置。
 *
 * @param {object} skill 目录条目（skill）
 * @param {object} options `{roots?: string[], trashRoot?: string}`
 */
export function planSkillDelete(skill, options = {}) {
	const item = skill || {};
	const roots = Array.isArray(options.roots) ? options.roots.filter(Boolean) : [];
	const dir = String(item.realDir || "");
	const blockers = [];
	const warnings = [];
	if (item.kind !== "skill") blockers.push({ code: "not-skill", text: "只有 Skill 条目能走这个动作" });
	if (item.hostPlugin) blockers.push({ code: "host-plugin", text: "这个 Skill 随插件 " + item.hostPlugin + " 一起安装：删它等于改那个插件的安装包。请卸载插件，或去插件源码里改" });
	if (dir === "") blockers.push({ code: "no-dir", text: "这条 Skill 没有独立目录（旧快照或不是文件系统里的 Skill）：没有东西可移" });
	if (dir !== "" && roots.length > 0 && !roots.some((root) => isInside(dir, root))) {
		blockers.push({ code: "outside-roots", text: "它不在任何已知 Skills 根目录里（" + dir + "）：面板只处置这几个根下的目录，别的请手工处理" });
	}
	if (item.backup === true) warnings.push({ code: "backup-dir", text: "它的目录名看着像一份 `.bak-*` 备份：删它不会影响正在用的那份，但也没必要删" });
	warnings.push({ code: "reversible", text: "删除 = 移到回收站（`trash/skills/`），面板里可以直接还原；不会硬删" });
	const trashRoot = String(options.trashRoot || "");
	return {
		op: "delete",
		label: ACTION_META.delete.label,
		available: blockers.length === 0,
		blocked: blockers.length > 0,
		blockers,
		warnings,
		summary: "把 `" + dir + "` 整个目录移进回收站" + (trashRoot ? "（" + trashRoot + "）" : "") + "；DSH 下次扫描就不再有这条 Skill。",
		target: dir,
		trashRoot,
		effect: ACTION_META.delete.effect,
		dangerous: true,
	};
}

/* ───────────── MCP：组合文件的文本操作（纯函数，可在探针里钉死） ───────────── */

/** 一行缩进（tab 当 4 空格；只看前导空白）。 */
export function indentOf(line) {
	const text = String(line ?? "");
	let width = 0;
	let index = 0;
	while (index < text.length) {
		const ch = text[index];
		if (ch === " ") width += 1;
		else if (ch === "\t") width += 4;
		else break;
		index += 1;
	}
	return { width, index };
}

const ENTRY_ID_RE = /^\s*-\s+id:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/;
const ENTRY_ANY_RE = /^\s*-\s+/;

/** 从一行里读条目 id（不是条目行就返回 ""）。 */
export function entryIdOfLine(line) {
	const match = ENTRY_ID_RE.exec(String(line ?? ""));
	return match ? match[1] : "";
}

/**
 * 找一条组合条目的**行区间**（0 基、闭区间）。
 *
 * 支持两种形状（本机全部组合文件都只有这两种）：
 *   · 列 0 的顶层条目 `- id: x` / `- name: y`
 *   · `- insert:` 块里 4 空格缩进的条目 `    - id: x`
 * 块的结束 = 下一条「缩进 ≤ 本条目缩进 且是 `- ` 开头」的行，或任何缩进 ≤ 本条目缩进的非空行（dedent）。
 * 末尾的空白行不吞进块里（否则删一条会顺手吃掉别人的分隔）。
 *
 * @param {string[]} lines
 * @param {{id?:string, line?:number}} target `line` 是 1 基的提示（来自 MCP 报告）
 * @returns {{ok:boolean, start:number, end:number, indent:number, reason?:string}}
 */
export function findEntryBlock(lines, target = {}) {
	const list = Array.isArray(lines) ? lines : [];
	const id = String(target.id || "");
	const hint = Number(target.line) > 0 ? Number(target.line) - 1 : -1;
	let start = -1;
	if (hint >= 0 && hint < list.length && (id === "" || entryIdOfLine(list[hint]) === id) && ENTRY_ANY_RE.test(list[hint])) start = hint;
	if (start < 0 && id !== "") {
		for (let index = 0; index < list.length; index += 1) {
			if (entryIdOfLine(list[index]) === id) {
				start = index;
				break;
			}
		}
	}
	if (start < 0) return { ok: false, start: -1, end: -1, indent: 0, reason: "没找到条目 " + (id || "(没有 id，也没有行号提示)") };
	const indent = indentOf(list[start]).width;
	let end = list.length - 1;
	for (let index = start + 1; index < list.length; index += 1) {
		const line = list[index];
		if (String(line).trim() === "") continue;
		const width = indentOf(line).width;
		if (width <= indent) {
			end = index - 1;
			break;
		}
	}
	while (end > start && String(list[end]).trim() === "") end -= 1;
	return { ok: true, start, end, indent };
}

/** 带行号的片段预览（前端确认条里直接给人看"要删的是哪一段"）。 */
export function blockPreview(lines, block, pad = 2) {
	const list = Array.isArray(lines) ? lines : [];
	if (!block || block.ok !== true) return "";
	const from = Math.max(0, block.start - pad);
	const to = Math.min(list.length - 1, block.end + pad);
	const out = [];
	for (let index = from; index <= to; index += 1) {
		const inBlock = index >= block.start && index <= block.end;
		out.push((inBlock ? "› " : "  ") + String(index + 1).padStart(4, " ") + " │ " + list[index]);
	}
	return out.join("\n");
}

/** 去掉行区间（返回新文本；保留原换行风格与末尾换行）。 */
export function removeBlock(text, block) {
	const source = String(text ?? "");
	if (!block || block.ok !== true) return source;
	const lines = source.split(/\r?\n/);
	if (block.start < 0 || block.end < block.start || block.end >= lines.length) return source;
	const kept = lines.slice(0, block.start).concat(lines.slice(block.end + 1));
	return kept.join("\n");
}

/** 统计文本里的条目数（用于删后校验；与 parseComposition 的条目数应一致）。 */
export function countEntryLines(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.filter((line) => ENTRY_ANY_RE.test(line) && /^\s*-\s+(id|name):/.test(line)).length;
}

/**
 * 删后校验（纯函数）：目标 id 少了一条、别的 id 一条没少、总条目数只少 1。
 *
 * @returns {{ok:boolean, reason:string, before:number, after:number}}
 */
export function verifyEntryRemoved(beforeText, afterText, id) {
	const before = parseComposition(String(beforeText ?? ""), { file: "before.yml" });
	const after = parseComposition(String(afterText ?? ""), { file: "after.yml" });
	const beforeCounts = new Map();
	const afterCounts = new Map();
	for (const entry of before) beforeCounts.set(String(entry.id || ""), (beforeCounts.get(String(entry.id || "")) || 0) + 1);
	for (const entry of after) afterCounts.set(String(entry.id || ""), (afterCounts.get(String(entry.id || "")) || 0) + 1);
	const wanted = String(id || "");
	if (wanted !== "") {
		const b = beforeCounts.get(wanted) || 0;
		const a = afterCounts.get(wanted) || 0;
		if (b - a !== 1) return { ok: false, reason: "目标条目少了 " + (b - a) + " 条（应为 1）", before: b, after: a };
	}
	for (const [key, count] of beforeCounts) {
		if (key === wanted) continue;
		if ((afterCounts.get(key) || 0) !== count) return { ok: false, reason: "别的条目被动了：" + key + " " + count + " → " + (afterCounts.get(key) || 0), before: count, after: afterCounts.get(key) || 0 };
	}
	if (before.length - after.length !== 1) return { ok: false, reason: "总条目数 " + before.length + " → " + after.length + "（应只少 1）", before: before.length, after: after.length };
	return { ok: true, reason: "", before: before.length, after: after.length };
}

/**
 * MCP 停用：往 profile 的 `cordis.patch.yml` 追加一条按 id 覆盖的 `disabled: true`。
 *
 * ★ 只写 id + disabled：不带 `name` / `config` —— 带了会在下次 DSH 升级时把旧 config 钉死。
 * ★ 幂等：文件里已经有同 id 且 `disabled: true` 的条目时返回 `changed:false`。
 *
 * @param {string} text 现有 patch 文本（文件不存在时传 ""）
 * @param {{entryId:string, serverName?:string, comment?:boolean}} input
 */
export function appendDisableEntry(text, input = {}) {
	const entryId = String(input.entryId || "");
	if (entryId === "") return { ok: false, changed: false, text: String(text ?? ""), reason: "没有条目 id：没法按 id 覆盖" };
	const source = String(text ?? "");
	const entries = parseComposition(source, { file: "cordis.patch.yml" });
	const already = entries.filter((entry) => String(entry.id || "") === entryId && entry.disabledKind === "off");
	if (already.length > 0) return { ok: true, changed: false, text: source, reason: "这个 id 已经有一条 disabled: true 了（幂等，不重复写）" };
	const lines = [];
	if (input.comment !== false) {
		lines.push("# 插件目录面板 · 停用 MCP 服务器 " + (input.serverName ? input.serverName + " " : "") + "（按 id 覆盖，改完需重启 DSH）");
	}
	lines.push("- id: " + entryId, "  disabled: true");
	const body = source === "" ? "" : source.replace(/\s*$/, "") + "\n";
	const next = body + lines.join("\n") + "\n";
	return { ok: true, changed: true, text: next, reason: "" };
}

/**
 * MCP 删除：判断这条条目能不能由面板删（只有 profile 自己那两份组合文件可以）。
 *
 * `bundle-patch`（node_modules 里某 bundle 自带的 patch）与 asar 里的层一律阻断：
 * 删它等于改安装包，下一次重装/升级就回来了，而且会让人以为"删干净了"。
 *
 * @param {object} server MCP 服务器（`lib/mcp.mjs` 的输出）
 * @param {{profileFiles?: Array<{file:string,text:string}>, patchFile?: string}} options
 */
export function planMcpRemove(server, options = {}) {
	const item = server || {};
	const profileFiles = Array.isArray(options.profileFiles) ? options.profileFiles : [];
	const file = String(item.file || "");
	const id = String(item.entryId || "");
	const blockers = [];
	const warnings = [];
	if (id === "") blockers.push({ code: "no-id", text: "这条条目没有 id：面板按 id 定位，删不了" });
	if (file === "") blockers.push({ code: "no-file", text: "读不到它声明在哪个文件里" });
	const known = profileFiles.find((entry) => normalizePath(entry.file) === normalizePath(file));
	if (file !== "" && !known) {
		blockers.push({
			code: "bundle-layer",
			text: "它不在 profile 自己那两份组合文件里（" + file + "）：多半是某个 bundle 自带的 patch 层。删它等于改那个插件的安装包，重装/升级就会回来 —— 请改插件源码，或先卸掉那个 bundle",
		});
	}
	let block = null;
	let lines = [];
	let preview = "";
	if (blockers.length === 0 && known) {
		lines = String(known.text ?? "").split(/\r?\n/);
		block = findEntryBlock(lines, { id, line: item.line });
		if (!block.ok) blockers.push({ code: "block-not-found", text: "在 " + file + " 里没定位到这条条目的完整段落（" + block.reason + "）" });
		else preview = blockPreview(lines, block);
	}
	warnings.push({ code: "restart", text: "改完**必须重启 DSH** —— `cordis.patch.yml` / `cordis.yml` 不热更（settings.yaml 才热生效）" });
	warnings.push({ code: "backup", text: "写盘前会把原文件备份成 `<文件名>.bak-<时间戳>`，写后重新解析校验（目标 id 少一条、别的条目一条不少）" });
	return {
		op: "remove",
		label: ACTION_META.remove.label,
		available: blockers.length === 0,
		blocked: blockers.length > 0,
		blockers,
		warnings,
		summary: "从 " + (file || "?") + " 里删掉 serverName=" + (item.serverName || "?") + " 的这一段（" + (block && block.ok ? block.start + 1 + "–" + (block.end + 1) + " 行" : "行区间未定") + "）。",
		target: file + (item.line ? ":" + item.line : ""),
		file,
		line: Number(item.line) || 0,
		block: block && block.ok ? { start: block.start, end: block.end } : null,
		preview,
		effect: ACTION_META.remove.effect,
		dangerous: true,
	};
}

/** MCP 停用的判据（比删除安全：不动原条目，只追加一条覆盖）。 */
export function planMcpDisable(server, options = {}) {
	const item = server || {};
	const id = String(item.entryId || "");
	const patchFile = String(options.patchFile || "");
	const blockers = [];
	if (id === "") blockers.push({ code: "no-id", text: "这条条目没有 id：没法按 id 覆盖（先给它补一个 id）" });
	const alreadyOff = item.state === "off";
	return {
		op: "disable",
		label: ACTION_META.disable.label,
		available: blockers.length === 0 && !alreadyOff,
		blocked: blockers.length > 0,
		blockers: alreadyOff ? [{ code: "already-off", text: "它现在已经是关掉的（`disabled: " + (item.disabledRaw || "true") + "` 那一行）" }] : blockers,
		warnings: [
			{ code: "restart", text: "写进去之后要**重启 DSH** 才生效（patch 层不热更）" },
			{ code: "append", text: "只往 " + (patchFile || "profile/cordis.patch.yml") + " 追加 2 行（按 id 覆盖），不动原条目" },
		],
		summary: "在 " + (patchFile || "profile/cordis.patch.yml") + " 末尾追加 `- id: " + id + "` + `disabled: true`（按 id 覆盖，只关它一台）。",
		target: (patchFile || "cordis.patch.yml") + " ← - id: " + id,
		file: patchFile,
		effect: ACTION_META.disable.effect,
		dangerous: false,
	};
}

/** 结果的人话（面板提示条 / 留痕 / 工具共用；失败也要能说清"为什么")。 */
export function describeActionResult(result) {
	const value = result || {};
	if (value.ok) return value.text || "已完成";
	return "没做成：" + (value.error || value.code || "未知原因");
}
