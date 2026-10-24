/**
 * history.mjs — 「自上次快照以来变了什么」（R17）。
 *
 * ★ 为什么要有它：面板能回答「我装了哪些 / 用不用 / 怎么删」，答不了**「这两天变了什么」** ——
 *   换会话接手、发版后复核、怀疑某个包被静默换过，都要这一条。而它需要**历史**：
 *   目录快照 `cache/catalog.json` 每次重建就把上一版覆盖掉了，没有任何地方留着"之前长什么样"。
 *
 * ★ 判据刻意窄（写进边界，别偷偷放宽）：
 *   · 插件比 `version / source / loadState`；
 *   · Skill 比 `source / hasDescription` —— Skill 没有版本号，正文改动这里**看不见**
 *     （那要内容哈希，得为 58 个技能各读一遍文件；代价与收益不成比例）；
 *   · **工具数、体积、git 脏文件不进历史**：前两个来自统计与懒算的体积快照，第三个随时都在变，
 *     放进来会让"变化"这条线天天有噪声，最后没人看。
 *
 * ★ 什么时候记一条：**指纹变了才记**。否则每次「重新扫描」都写一条，历史全是噪声，
 *   而且基线时间会被刷新 —— 「自 11:27 以来」永远只剩几分钟，等于看不到真实的变化窗口。
 *
 * 本模块全是**纯函数**（唯一的 IO 是 `createHash` 的内存计算），落盘由 service 负责 ——
 * 于是 `dev/probe-history.mjs` 能在合成数据上把这些判断跑一遍。
 *
 * @module dsh-plugin-catalog/history
 */

import { createHash } from "node:crypto";

export const HISTORY_VERSION = 1;
/** 留多少条快照：只在**指纹变化**时追加，20 条足够覆盖几个月的人工操作。 */
export const MAX_SNAPSHOTS = 20;

/** 一个条目的「信号」：变没变只看这四个字段。 */
export function signalOf(entry) {
	return {
		version: String(entry?.version ?? ""),
		source: String(entry?.source ?? ""),
		loadState: String(entry?.loadState ?? ""),
		description: entry?.kind === "skill" ? (entry?.hasDescription ? 1 : 0) : 0,
	};
}

const FIELDS = ["version", "source", "loadState", "description"];

/** 两个条目的信号是否一致（导出给探针与 diff 用，避免两处各写一份比较逻辑）。 */
export function sameSignal(a, b) {
	if (!a || !b) return false;
	return FIELDS.every((field) => String(a[field] ?? "") === String(b[field] ?? ""));
}

/**
 * 目录 → 快照。`overrides` 是用户手工改过的来源（`{sources: {id: source}}`）——
 * 手工改正本身也是"变化"，必须进历史，否则改完来源下次重建又"没变"。
 */
export function snapshotOf(catalog, overrides, at = Date.now()) {
	const entries = {};
	const sourceOf = (id, fallback) => (overrides && overrides.sources && overrides.sources[id]) || fallback || "";
	for (const plugin of catalog?.plugins ?? []) {
		const id = plugin.id || "plugin:" + plugin.name;
		entries[id] = { name: plugin.name || "", kind: "plugin", ...signalOf({ ...plugin, kind: "plugin", source: sourceOf(id, plugin.source) }) };
	}
	for (const skill of catalog?.skills ?? []) {
		const id = skill.id || "skill:" + skill.name;
		/* ★ 必须显式给 kind：catalog 里的 skill 没有 kind 字段（那是 listEntries 才补的），
		   少了它 `信号.description` 永远是 0，Skill 的唯一编辑信号就瞎了。 */
		entries[id] = { name: skill.name || "", kind: "skill", ...signalOf({ ...skill, kind: "skill", source: sourceOf(id, skill.source) }) };
	}
	const snapshot = { at: Number(at) || Date.now(), count: Object.keys(entries).length, entries };
	snapshot.fingerprint = fingerprintOf(snapshot);
	return snapshot;
}

/** 指纹：条目 id → 四个信号字段的稳定串，取前 12 位十六进制。 */
export function fingerprintOf(snapshot) {
	const entries = snapshot?.entries || {};
	const ids = Object.keys(entries).sort();
	const text = ids.map((id) => [id].concat(FIELDS.map((field) => String(entries[id][field] ?? ""))).join("\u0001")).join("\u0002");
	return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

/**
 * 两份快照的差异。
 * @param {{entries?:object}|null} prev 基线（没有 = 第一次）
 * @param {{entries?:object}|null} next
 */
export function diffSnapshots(prev, next) {
	const before = prev?.entries || {};
	const after = next?.entries || {};
	const added = [];
	const removed = [];
	const versionChanged = [];
	const sourceChanged = [];
	const loadStateChanged = [];
	const edited = [];
	let unchanged = 0;
	for (const [id, entry] of Object.entries(after)) {
		const old = before[id];
		if (!old) {
			added.push({ id, name: entry.name, kind: entry.kind, version: entry.version, source: entry.source });
			continue;
		}
		if (sameSignal(old, entry)) {
			unchanged += 1;
			continue;
		}
		if (String(old.version ?? "") !== String(entry.version ?? "")) versionChanged.push({ id, name: entry.name, kind: entry.kind, from: old.version, to: entry.version });
		if (String(old.source ?? "") !== String(entry.source ?? "")) sourceChanged.push({ id, name: entry.name, kind: entry.kind, from: old.source, to: entry.source });
		if (String(old.loadState ?? "") !== String(entry.loadState ?? "")) loadStateChanged.push({ id, name: entry.name, kind: entry.kind, from: old.loadState, to: entry.loadState });
		/* Skill 没有版本号：描述从有到无（或反过来）是唯一能看见的"被编辑过"信号。
		   ★ 必须单列一个类别 —— 只写进 sameSignal 而不在 diff 里归类，会让这类变化**静默消失**:
		     sameSignal 判为"变了"，可哪个桶都没进，total 还是 0（H10 就是这么抓到的）。 */
		if (String(old.description ?? "") !== String(entry.description ?? "")) edited.push({ id, name: entry.name, kind: entry.kind, from: old.description ? "有描述" : "无描述", to: entry.description ? "有描述" : "无描述" });
	}
	for (const [id, old] of Object.entries(before)) {
		if (!after[id]) removed.push({ id, name: old.name, kind: old.kind, version: old.version, source: old.source });
	}
	const sort = (list) => list.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
	for (const list of [added, removed, versionChanged, sourceChanged, loadStateChanged, edited]) sort(list);
	const touched = new Set();
	for (const list of [added, removed, versionChanged, sourceChanged, loadStateChanged, edited]) for (const item of list) touched.add(item.id);
	const counts = {
		added: added.length,
		removed: removed.length,
		version: versionChanged.length,
		source: sourceChanged.length,
		loadState: loadStateChanged.length,
		edited: edited.length,
		total: touched.size,
	};
	return { counts, unchanged, added, removed, versionChanged, sourceChanged, loadStateChanged, edited };
}

/**
 * 面板 / 报告共用的摘要。**第一条快照（prev=null）必须是 0 处变化** ——
 * 把它当成"所有条目都是新增"会让第一次打开就报 133 处新增，
 * 用户会以为刚装了一堆东西（hosttest 抓到过：first=true 但 total=133）。
 * @param {object|null} prev 基线快照
 * @param {object|null} next 当前快照
 * @param {number} [cap] 每类最多带几条（`counts` 里永远是真实数字）
 */
export function summarizeChanges(prev, next, cap = 20) {
	if (!next) return null;
	const base = { at: Number(next.at) || 0, baselineAt: Number(prev?.at) || 0, first: !prev, total: Number(next.count) || 0 };
	if (!prev) {
		return {
			...base,
			unchanged: Number(next.count) || 0,
			counts: { added: 0, removed: 0, version: 0, source: 0, loadState: 0, edited: 0, total: 0 },
			added: [],
			removed: [],
			versionChanged: [],
			sourceChanged: [],
			loadStateChanged: [],
			edited: [],
		};
	}
	const diff = diffSnapshots(prev, next);
	return {
		...base,
		unchanged: diff.unchanged,
		counts: diff.counts,
		added: diff.added.slice(0, cap),
		removed: diff.removed.slice(0, cap),
		versionChanged: diff.versionChanged.slice(0, cap),
		sourceChanged: diff.sourceChanged.slice(0, cap),
		loadStateChanged: diff.loadStateChanged.slice(0, cap),
		edited: diff.edited.slice(0, cap),
	};
}

/** 只留最近 N 条（按 at 升序返回）。 */
export function pruneSnapshots(snapshots, keep = MAX_SNAPSHOTS) {
	const list = (Array.isArray(snapshots) ? snapshots : []).filter((item) => item && item.entries && Number.isFinite(Number(item.at))).slice().sort((a, b) => Number(a.at) - Number(b.at));
	const limit = Math.max(1, Number(keep) || MAX_SNAPSHOTS);
	return list.slice(-limit);
}

/**
 * 读历史文件 → `{version, snapshots}`。坏文件当空历史（不抛：面板不该因为一行脏 JSON 打不开）。
 */
export function normalizeHistory(raw) {
	const snapshots = pruneSnapshots(raw?.snapshots);
	return { version: HISTORY_VERSION, snapshots };
}

/** 把每条变化压成一句人话（工具/报告/面板同一套措辞，别各写一份）。 */
export function describeChange(item, kind) {
	const name = item.name || item.id;
	if (kind === "added") return `+ ${name}${item.version ? " " + item.version : ""}`;
	if (kind === "removed") return `− ${name}${item.version ? " " + item.version : ""}`;
	if (kind === "version") return `${name} ${item.from || "?"} → ${item.to || "?"}`;
	if (kind === "source") return `${name} ${item.from || "?"} → ${item.to || "?"}`;
	if (kind === "loadState") return `${name} ${item.from || "未判"} → ${item.to || "未判"}`;
	if (kind === "edited") return `${name} 被编辑（${item.from} → ${item.to}）`;
	return name;
}
