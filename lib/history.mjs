/**
 * history.mjs — 「自上次快照以来变了什么」（R17）。
 *
 * ★ 为什么要有它：面板能回答「我装了哪些 / 用不用 / 怎么删」，答不了**「这两天变了什么」** ——
 *   换会话接手、发版后复核、怀疑某个包被静默换过，都要这一条。而它需要**历史**：
 *   目录快照 `cache/catalog.json` 每次重建就把上一版覆盖掉了，没有任何地方留着"之前长什么样"。
 *
 * ★ 判据刻意窄（写进边界，别偷偷放宽）：
 *   · 插件比 `version / source / loadState`；
 *   · Skill 比 `source / hasDescription / contentHash` —— R19 起正文改动也看得见
 *     （catalog 读 SKILL.md 时顺手算了一个 12 位内容哈希，不额外读文件）；
 *   · **工具数、体积、git 脏文件不进历史**：前两个来自统计与懒算的体积快照，第三个随时都在变，
 *     放进来会让"变化"这条线天天有噪声，最后没人看。
 *
 * ★ 什么时候记一条：**指纹变了才记**。否则每次「重新扫描」都写一条，历史全是噪声，
 *   而且基线时间会被刷新 —— 「自 11:27 以来」永远只剩几分钟，等于看不到真实的变化窗口。
 *
 * ★ v2（R19）加了 `content` 字段。旧快照（v1）里没有它 —— **不能把"两条快照里一条没有哈希"
 *   当成"技能被编辑了"**，否则升级后第一次重建就报 58 处「被编辑」。规则写在
 *   `compareEntries()` 里：内容只在**两边都有哈希**时才比较，缺的一侧视为"当时还没记"。
 *
 * ★ v3（R23）加了 `composition` 字段（配置层签名）。改 `cordis.patch.yml` 的 `disabled`、
 *   往 `dsh.profile.bundles` 加包，**目录条目一个都不会变** —— v2 的变化条对这类改动完全失明。
 *   规则与 R19 同型：两边都有 `composition.fingerprint` 才比较，单边缺视为"当时还没记"。
 *
 * 本模块全是**纯函数**（唯一的 IO 是 `createHash` 的内存计算），落盘由 service 负责 ——
 * 于是 `dev/probe-history.mjs` 能在合成数据上把这些判断跑一遍。
 *
 * @module dsh-plugin-catalog/history
 */

import { createHash } from "node:crypto";

export const HISTORY_VERSION = 3;
/** 「已看过」基线的文件格式版本（与 history.json 分开存：确认动作不该改写历史本身）。 */
export const ACK_VERSION = 1;
/** 留多少条快照：只在**指纹变化**时追加，20 条足够覆盖几个月的人工操作。 */
export const MAX_SNAPSHOTS = 20;

/** 配置层签名里参与「变没变」判断的计数（指纹之外只用来写人话）。 */
export const COMPOSITION_FIELDS = Object.freeze(["entries", "on", "off", "conditional", "patched", "bundles", "files"]);
/** 计数字段的人话标签（面板 / 报告 / 工具共用；别各自再写一份）。 */
export const COMPOSITION_LABELS = Object.freeze({ entries: "生效条目", on: "启用", off: "关掉", conditional: "条件启用", patched: "被 patch 覆盖", bundles: "bundles", files: "组合文件" });
/** R25：声明条目的三种 disabled 语义 → 人话（下钻时写「谁从开变关」用）。 */
export const DISABLED_KIND_LABELS = Object.freeze({ on: "启用", off: "关掉", expression: "条件" });
/** R25：下钻明细最多列多少条（面板一行放不下 246 条；完整名单在快照里）。 */
export const COMPOSITION_DETAIL_CAP = 40;


/** 一个条目的「信号」：变没变只看这几个字段。 */
export function signalOf(entry) {
	return {
		version: String(entry?.version ?? ""),
		source: String(entry?.source ?? ""),
		loadState: String(entry?.loadState ?? ""),
		description: entry?.kind === "skill" ? (entry?.hasDescription ? 1 : 0) : 0,
		/* R19：Skill 的正文指纹。插件没有"正文"这个概念，恒为 ""（不参与比较）。 */
		content: entry?.kind === "skill" ? String(entry?.contentHash ?? "") : "",
	};
}

const FIELDS = ["version", "source", "loadState", "description", "content"];

/**
 * 逐字段比较两个信号。**diff 与 sameSignal 共用它**（两处各写一份判据迟早会差）。
 *
 * ★ `content` 的三态规则（R19 升级窗口）：只有**两边都有哈希**才比；
 *   旧快照里没有这个字段时视为「当时还没记」，不算变化 ——
 *   否则升级后第一次重建会把 58 个技能全报成「被编辑」。
 * @returns {{changed: {version:boolean,source:boolean,loadState:boolean,description:boolean,content:boolean}, any: boolean}}
 */
export function compareEntries(a, b) {
	const left = a || {};
	const right = b || {};
	const changed = {
		version: String(left.version ?? "") !== String(right.version ?? ""),
		source: String(left.source ?? "") !== String(right.source ?? ""),
		loadState: String(left.loadState ?? "") !== String(right.loadState ?? ""),
		description: String(left.description ?? "") !== String(right.description ?? ""),
		content: String(left.content ?? "") !== "" && String(right.content ?? "") !== "" && String(left.content ?? "") !== String(right.content ?? ""),
	};
	return { changed, any: Object.values(changed).some(Boolean) };
}

/** 两个条目的信号是否一致（导出给探针与 diff 用）。 */
export function sameSignal(a, b) {
	if (!a || !b) return false;
	return !compareEntries(a, b).any;
}

/**
 * 配置层签名（`lib/composition.mjs` 的 `signatureOf` 产出）→ 快照里要存的那一小块。
 * 只要 `fingerprint` 不是空串就收；缺字段按 0 —— 但**缺 fingerprint 就整块丢掉**，
 * 不能伪造一个空签名（那会让下一次重建把「读不到」误报成「配置清空了」）。
 */
export function compositionSignalOf(input) {
	if (!input || typeof input !== "object") return null;
	const fingerprint = String(input.fingerprint ?? "");
	if (fingerprint === "") return null;
	const counts = {};
	for (const field of COMPOSITION_FIELDS) {
		const value = Number(input.counts?.[field]);
		counts[field] = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
	}
	const signal = { fingerprint, counts };
	/* R25：声明身份表（下钻用）。**旧快照没有这一段就保持"没记"**（undefined），
	   不能补成空数组 —— 否则第一次下钻会把 50 个 bundle 全报成"新加的"。 */
	if (Array.isArray(input.decls)) {
		signal.decls = [];
		for (const row of input.decls.slice(0, 2000)) {
			if (!row || typeof row !== "object") continue;
			const id = String(row.id ?? "");
			if (id === "") continue;
			signal.decls.push({ id, name: String(row.name ?? ""), kind: String(row.kind ?? "on") });
		}
	}
	if (Array.isArray(input.bundles)) signal.bundles = input.bundles.map((name) => String(name ?? "")).filter(Boolean).slice(0, 500);
	return signal;
}

/**
 * 目录 → 快照。`overrides` 是用户手工改过的来源（`{sources: {id: source}}`）——
 * 手工改正本身也是"变化"，必须进历史，否则改完来源下次重建又"没变"。
 *
 * @param {object} catalog
 * @param {object|null} overrides
 * @param {number} [at]
 * @param {{fingerprint:string,counts:object}|null} [composition] R23：配置层签名
 */
export function snapshotOf(catalog, overrides, at = Date.now(), composition = null) {
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
	const signal = compositionSignalOf(composition);
	if (signal) snapshot.composition = signal;
	snapshot.fingerprint = fingerprintOf(snapshot);
	return snapshot;
}

/**
 * 指纹：条目 id → 五个信号字段的稳定串，取前 12 位十六进制。
 * ★ R23：配置层签名也折进指纹 —— 否则「只改了 disabled / 只加了 bundle」时
 *   `recordSnapshot` 认为没变、根本不追加快照，配置层的变化永远进不了历史。
 *   旧快照没有 composition，算出来与新版不同 → 升级后**只追加一条**结构快照；
 *   那一条的 diff 按单边缺规则不报变化（total 0），下一轮就稳定了。
 */
export function fingerprintOf(snapshot) {
	const entries = snapshot?.entries || {};
	const ids = Object.keys(entries).sort();
	const text = ids.map((id) => [id].concat(FIELDS.map((field) => String(entries[id][field] ?? ""))).join("\u0001")).join("\u0002");
	const composition = String(snapshot?.composition?.fingerprint ?? "");
	return createHash("sha1").update(text + "\u0003" + composition, "utf8").digest("hex").slice(0, 12);
}

/**
 * 配置层签名差异（R23）。
 *
 * ★ 与 `compareEntries` 同一条迁移规则：**单边缺 `composition` 就不判** ——
 *   旧快照（v2 及更早）里根本没记配置层，升级后第一次重建不能因此报一条「配置层变了」。
 * ★ 指纹相同 → 声明没变（计数即使有差也是空文件之类，不值得占一行）。
 * ★ 指纹不同但计数完全相同（换了哪个条目被 disabled）时 `changed` 是空数组：
 *   这仍然是变化，调用方要按「条目变了」写人话，不能因为计数没差就丢掉。
 *
 * @returns {{fingerprintFrom:string, fingerprintTo:string, changed:Array<{field:string,from:number,to:number}>, entries:number}|null}
 */
export function compareComposition(prev, next) {
	const before = prev?.composition;
	const after = next?.composition;
	if (!before || !after) return null;
	const from = String(before.fingerprint ?? "");
	const to = String(after.fingerprint ?? "");
	if (from === "" || to === "" || from === to) return null;
	const changed = [];
	for (const field of COMPOSITION_FIELDS) {
		const left = Number(before.counts?.[field]) || 0;
		const right = Number(after.counts?.[field]) || 0;
		if (left !== right) changed.push({ field, from: left, to: right });
	}
	return { fingerprintFrom: from, fingerprintTo: to, changed, entries: Number(after.counts?.entries) || 0, ...compareCompositionDetail(before, after) };
}

/**
 * R25：配置层下钻 —— 具体哪条声明 / 哪个 bundle 变了。
 *
 * ★ 单边缺 `decls` / `bundles` 就不判（旧快照没这一段）：空数组与"没记"必须分开，
 *   否则升级后会一次报 246 条新增 / 50 个 bundle 新增（与 R19 正文哈希同型）。
 * ★ 只比 identity（id / name / disabledKind）与 bundles 名单；**解析结果（present/asar）不进来**，
 *   那是安装态，换台机器就会变。
 * @returns {{declsAdded:Array, declsRemoved:Array, stateChanged:Array, bundlesAdded:string[], bundlesRemoved:string[], hasDetail:boolean}}
 */
export function compareCompositionDetail(before, after) {
	const out = { declsAdded: [], declsRemoved: [], stateChanged: [], bundlesAdded: [], bundlesRemoved: [], hasDetail: false };
	const left = Array.isArray(before?.decls) ? before.decls : null;
	const right = Array.isArray(after?.decls) ? after.decls : null;
	if (left && right) {
		out.hasDetail = true;
		const map = new Map(left.map((row) => [row.id, row]));
		for (const row of right) {
			const old = map.get(row.id);
			if (!old) out.declsAdded.push({ id: row.id, name: row.name || row.id });
			else if (old.kind !== row.kind) out.stateChanged.push({ id: row.id, name: row.name || old.name || row.id, from: old.kind, to: row.kind });
			map.delete(row.id);
		}
		for (const row of map.values()) out.declsRemoved.push({ id: row.id, name: row.name || row.id });
	}
	const leftBundles = Array.isArray(before?.bundles) ? before.bundles : null;
	const rightBundles = Array.isArray(after?.bundles) ? after.bundles : null;
	if (leftBundles && rightBundles) {
		out.hasDetail = true;
		const beforeSet = new Set(leftBundles);
		const afterSet = new Set(rightBundles);
		for (const name of rightBundles) if (!beforeSet.has(name)) out.bundlesAdded.push(name);
		for (const name of leftBundles) if (!afterSet.has(name)) out.bundlesRemoved.push(name);
	}
	for (const key of ["declsAdded", "declsRemoved", "stateChanged"]) out[key] = out[key].slice(0, COMPOSITION_DETAIL_CAP);
	out.bundlesAdded = out.bundlesAdded.slice(0, COMPOSITION_DETAIL_CAP);
	out.bundlesRemoved = out.bundlesRemoved.slice(0, COMPOSITION_DETAIL_CAP);
	return out;
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
		const { changed, any } = compareEntries(old, entry);
		if (!any) {
			unchanged += 1;
			continue;
		}
		if (changed.version) versionChanged.push({ id, name: entry.name, kind: entry.kind, from: old.version, to: entry.version });
		if (changed.source) sourceChanged.push({ id, name: entry.name, kind: entry.kind, from: old.source, to: entry.source });
		if (changed.loadState) loadStateChanged.push({ id, name: entry.name, kind: entry.kind, from: old.loadState, to: entry.loadState });
		/* Skill 没有版本号：正文指纹变化是**最主要的编辑信号**；描述从有到无/反过来是旧信号。
		   ★ 两者同时变时只报一行（内容是整份文件的哈希，已经包含描述）——
		     否则用户会把「改了一段描述」看成"改了两处"。
		   ★ 必须单列一个类别 —— 只写进 compareEntries 而不在 diff 里归类，
		     会让这类变化**静默消失**：判为"变了"，可哪个桶都没进，total 还是 0（H10 抓到过同型 bug）。 */
		if (changed.content) edited.push({ id, name: entry.name, kind: entry.kind, reason: "content", from: String(old.content).slice(0, 8), to: String(entry.content).slice(0, 8) });
		else if (changed.description) edited.push({ id, name: entry.name, kind: entry.kind, reason: "description", from: old.description ? "有描述" : "无描述", to: entry.description ? "有描述" : "无描述" });
	}
	for (const [id, old] of Object.entries(before)) {
		if (!after[id]) removed.push({ id, name: old.name, kind: old.kind, version: old.version, source: old.source });
	}
	const sort = (list) => list.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
	for (const list of [added, removed, versionChanged, sourceChanged, loadStateChanged, edited]) sort(list);
	/* R23：配置层（声明层）单独一类 —— 改 disabled / 加 bundle 时目录条目一个都没变，
	   不单列的话这类改动会**静默消失**（判据里有、却哪个桶都没进）。 */
	const compositionDiff = compareComposition(prev, next);
	const compositionChanged = compositionDiff ? [{ id: "composition", name: "配置层", kind: "composition", ...compositionDiff }] : [];
	const touched = new Set();
	for (const list of [added, removed, versionChanged, sourceChanged, loadStateChanged, edited]) for (const item of list) touched.add(item.id);
	const counts = {
		added: added.length,
		removed: removed.length,
		version: versionChanged.length,
		source: sourceChanged.length,
		loadState: loadStateChanged.length,
		edited: edited.length,
		composition: compositionChanged.length,
		/* 配置层不是某个条目：它自己占 1 处，否则 total 会是 0、面板整条变化条都不显示。 */
		total: touched.size + compositionChanged.length,
	};
	return { counts, unchanged, added, removed, versionChanged, sourceChanged, loadStateChanged, edited, compositionChanged };
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
			counts: { added: 0, removed: 0, version: 0, source: 0, loadState: 0, edited: 0, composition: 0, total: 0 },
			added: [],
			removed: [],
			versionChanged: [],
			sourceChanged: [],
			loadStateChanged: [],
			edited: [],
			compositionChanged: [],
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
		compositionChanged: diff.compositionChanged.slice(0, cap),
	};
}

/** 只留最近 N 条（按 at 升序返回）。 */
export function pruneSnapshots(snapshots, keep = MAX_SNAPSHOTS) {
	const list = (Array.isArray(snapshots) ? snapshots : []).filter((item) => item && item.entries && Number.isFinite(Number(item.at))).slice().sort((a, b) => Number(a.at) - Number(b.at));
	const limit = Math.max(1, Number(keep) || MAX_SNAPSHOTS);
	return list.slice(-limit);
}

/**
 * 回看历史（R21）：把保存下来的每条快照折成「相邻两个快照之间变了什么」。
 *
 * ★ 为什么要有它：`changes` 只给**最近**一个窗口，`sinceAck` 只给**确认之后**的窗口。
 *   再往前的快照一直躺在 `history.json` 里，但没有任何界面能读到 —— 交接时问
 *   「今天下午都改过什么」，只能靠翻日志。这里把数据变成一条时间线。
 * ★ 基线（第一条快照）不产出一行：它没有「之前」，写成"新增 133 条"会误导。
 * ★ 返回**新的在前**（与面板上的阅读顺序一致）；每条只带每类前 `cap` 个名字，
 *   `counts` 里始终是真实数字。指纹相同的相邻快照（手工改文件才会出现）直接跳过。
 *
 * @param {Array<object>} snapshots
 * @param {{cap?:number}} [options]
 * @returns {Array<{at:number, baselineAt:number, total:number, counts:object, added:object[], removed:object[], versionChanged:object[], sourceChanged:object[], loadStateChanged:object[], edited:object[]}>}
 */
export function timelineOf(snapshots, options = {}) {
	const cap = Math.max(1, Number(options.cap) || 4);
	const list = pruneSnapshots(snapshots);
	const rows = [];
	for (let index = 1; index < list.length; index += 1) {
		const prev = list[index - 1];
		const next = list[index];
		if (prev.fingerprint && next.fingerprint && prev.fingerprint === next.fingerprint) continue;
		const diff = diffSnapshots(prev, next);
		if (diff.counts.total === 0) continue;
		rows.push({
			at: Number(next.at) || 0,
			baselineAt: Number(prev.at) || 0,
			total: Number(next.count) || 0,
			counts: diff.counts,
			added: diff.added.slice(0, cap),
			removed: diff.removed.slice(0, cap),
			versionChanged: diff.versionChanged.slice(0, cap),
			sourceChanged: diff.sourceChanged.slice(0, cap),
			loadStateChanged: diff.loadStateChanged.slice(0, cap),
			edited: diff.edited.slice(0, cap),
			compositionChanged: diff.compositionChanged.slice(0, cap),
		});
	}
	return rows.reverse();
}

/**
 * 读历史文件 → `{version, snapshots}`。坏文件当空历史（不抛：面板不该因为一行脏 JSON 打不开）。
 */
export function normalizeHistory(raw) {
	const snapshots = pruneSnapshots(raw?.snapshots);
	return { version: HISTORY_VERSION, snapshots };
}

/**
 * 读「已看过」文件 → `{version, at, snapshot}` 或 `null`。
 *
 * ★ 口径：坏文件 / 空快照 / 时间不可用一律当"没标记过"（面板不该因为一行脏 JSON 打不开），
 *   **但不删除文件** —— 用户下次点「标记已看过」会被新快照覆盖。
 * ★ 基线存的是**确认那一刻的整份目录快照**，不是时间戳：时间戳只能说明"我点过按钮"，
 *   说明不了"我看到的是哪一版"（两次重建之间可能正好有变化）。
 * @param {object|null} raw
 */
export function normalizeAck(raw) {
	if (!raw || typeof raw !== "object") return null;
	const stored = raw.snapshot;
	const entries = stored && typeof stored === "object" ? stored.entries : null;
	if (!entries || typeof entries !== "object") return null;
	const at = Number(raw.at);
	if (!Number.isFinite(at) || at <= 0) return null;
	const count = Object.keys(entries).length;
	if (count === 0) return null;
	const baseline = { at: Number(stored.at) || at, count: Number(stored.count) || count, entries, fingerprint: String(stored.fingerprint || "") };
	/* R23：配置层签名也留着 —— 否则「自上次确认以来」永远报不出配置层的变化。
	   缺 fingerprint 就当没记（不伪造空签名）。 */
	const composition = compositionSignalOf(stored.composition);
	if (composition) baseline.composition = composition;
	return { version: ACK_VERSION, at, snapshot: baseline };
}

/** R25：把配置层下钻明细压成人话（报告/工具/时间线共用；面板另有一份等价的 UI 版本）。 */
export function compositionDetailText(item, cap = 4) {
	const rows = [];
	const kindLabel = (kind) => DISABLED_KIND_LABELS[kind] || kind || "?";
	for (const change of Array.isArray(item?.stateChanged) ? item.stateChanged : []) rows.push(`${change.name} ${kindLabel(change.from)}→${kindLabel(change.to)}`);
	for (const row of Array.isArray(item?.declsAdded) ? item.declsAdded : []) rows.push(`+ ${row.name}（新声明）`);
	for (const row of Array.isArray(item?.declsRemoved) ? item.declsRemoved : []) rows.push(`− ${row.name}（声明移除）`);
	for (const name of Array.isArray(item?.bundlesAdded) ? item.bundlesAdded : []) rows.push(`bundles +${name}`);
	for (const name of Array.isArray(item?.bundlesRemoved) ? item.bundlesRemoved : []) rows.push(`bundles −${name}`);
	if (rows.length <= cap) return rows;
	const rest = rows.length - cap;
	return rows.slice(0, cap).concat(`…等 ${rest} 条`);
}

/** 把每条变化压成一句人话（工具/报告/面板同一套措辞，别各写一份）。 */
export function describeChange(item, kind) {
	const name = item.name || item.id;
	if (kind === "added") return `+ ${name}${item.version ? " " + item.version : ""}`;
	if (kind === "removed") return `− ${name}${item.version ? " " + item.version : ""}`;
	if (kind === "version") return `${name} ${item.from || "?"} → ${item.to || "?"}`;
	if (kind === "source") return `${name} ${item.from || "?"} → ${item.to || "?"}`;
	if (kind === "loadState") return `${name} ${item.from || "未判"} → ${item.to || "未判"}`;
	/* R23：配置层不是"某个条目" —— 计数差能说清就说计数，说不清（换了哪个条目被关掉）就报总数。
	   措辞**不带「配置层：」前缀**：调用方本来就按桶加标签（报告写「**配置层**：…」，面板写在同一行）。 */
	if (kind === "composition") {
		const bits = (Array.isArray(item.changed) ? item.changed : []).map((change) => (COMPOSITION_LABELS[change.field] || change.field) + " " + change.from + " → " + change.to);
		/* R25：计数说不清「换了哪个条目」——有明细就接在后面（最多 4 条，多的写"等 N 条"）。 */
		bits.push(...compositionDetailText(item));
		return bits.length > 0 ? bits.join("；") : "条目变了（生效 " + (Number(item.entries) || 0) + "）";
	}
	if (kind === "edited") return item.reason === "content" ? `${name} 正文已改（${item.from || "?"} → ${item.to || "?"}）` : `${name} 被编辑（${item.from} → ${item.to}）`;
	return name;
}
